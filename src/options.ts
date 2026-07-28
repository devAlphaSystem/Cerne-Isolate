import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";

import type { ProcessEventListener, ProcessExecutorOptions, ProcessPoolOptions } from "./types";

const MAX_TIMER_MS = 2_147_483_647;

/** Recycles a process after ten successful tasks, so a leak in the handler cannot grow unbounded. */
const DEFAULT_MAX_JOBS_PER_PROCESS = 10;
/** Recycles a process after ten minutes, so a long-lived pool still renews its children. */
const DEFAULT_MAX_LIFETIME_MS = 600_000;

export interface ResolvedPoolPolicy {
  idleTimeoutMs: number;
  maxJobsPerProcess: number;
  maxLifetimeMs: number;
}

export interface ResolvedProcessOptions {
  workerPath: string;
  concurrency: number;
  maxQueue: number;
  timeoutMs: number;
  killGraceMs: number;
  onEvent?: ProcessEventListener;
  pool?: ResolvedPoolPolicy;
}

function integerInRange(name: string, value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return resolved;
}

function resolveWorkerPath(worker: ProcessExecutorOptions["worker"]): string {
  if (worker instanceof URL) {
    if (worker.protocol !== "file:" || worker.search !== "" || worker.hash !== "") {
      throw new TypeError("worker must be a file URL without query parameters or a fragment.");
    }
    return fileURLToPath(worker);
  }
  if (typeof worker !== "string" || worker.trim() === "" || !isAbsolute(worker)) {
    throw new TypeError("worker must be an absolute file path or a file URL.");
  }
  return worker;
}

/**
 * Validates executor configuration while preserving a fixed, application-selected worker path.
 */
export function resolveProcessExecutorOptions(options: ProcessExecutorOptions): ResolvedProcessOptions {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("options must be an object.");
  }
  if (options.onEvent !== undefined && typeof options.onEvent !== "function") {
    throw new TypeError("onEvent must be a function.");
  }

  return {
    workerPath: resolveWorkerPath(options.worker),
    concurrency: integerInRange("concurrency", options.concurrency, 1, 1, 1024),
    maxQueue: integerInRange("maxQueue", options.maxQueue, 100, 0, 1_000_000),
    timeoutMs: integerInRange("timeoutMs", options.timeoutMs, 60_000, 0, MAX_TIMER_MS),
    killGraceMs: integerInRange("killGraceMs", options.killGraceMs, 250, 0, 60_000),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  };
}

/**
 * Validates pool configuration on top of the shared executor rules. The idle deadline is required
 * because a pool without one would keep processes alive for the lifetime of the application.
 */
export function resolveProcessPoolOptions(options: ProcessPoolOptions): ResolvedProcessOptions {
  const base = resolveProcessExecutorOptions(options);
  return {
    ...base,
    pool: {
      idleTimeoutMs: integerInRange("idleTimeoutMs", options.idleTimeoutMs, Number.NaN, 1, MAX_TIMER_MS),
      maxJobsPerProcess: integerInRange("maxJobsPerProcess", options.maxJobsPerProcess, DEFAULT_MAX_JOBS_PER_PROCESS, 0, 1_000_000),
      maxLifetimeMs: integerInRange("maxLifetimeMs", options.maxLifetimeMs, DEFAULT_MAX_LIFETIME_MS, 0, MAX_TIMER_MS),
    },
  };
}
