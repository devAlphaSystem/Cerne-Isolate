import { resolveProcessPoolOptions } from "./options";
import { ProcessRuntime } from "./runtime";
import type { ProcessPool, ProcessPoolOptions } from "./types";

/**
 * Creates a pool that reuses child processes between typed tasks. Processes are created on demand,
 * run one task at a time, and are discarded on any failure or configured lifecycle limit.
 */
export function createProcessPool<Payload = unknown, Result = unknown>(options: ProcessPoolOptions): ProcessPool<Payload, Result> {
  return new ProcessRuntime<Payload, Result>(resolveProcessPoolOptions(options));
}
