import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";

import type { ProcessEventListener, ProcessExecutorOptions } from "./types";

const MAX_TIMER_MS = 2_147_483_647;

export interface ResolvedProcessExecutorOptions {
  workerPath: string;
  concurrency: number;
  maxQueue: number;
  timeoutMs: number;
  killGraceMs: number;
  onEvent?: ProcessEventListener;
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
export function resolveProcessExecutorOptions(options: ProcessExecutorOptions): ResolvedProcessExecutorOptions {
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
