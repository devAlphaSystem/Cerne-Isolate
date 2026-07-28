import { resolveProcessExecutorOptions } from "./options";
import { ProcessRuntime } from "./runtime";
import type { ProcessExecutor, ProcessExecutorOptions } from "./types";

/**
 * Creates an executor that runs at most one typed task in each disposable child process.
 */
export function createProcessExecutor<Payload = unknown, Result = unknown>(options: ProcessExecutorOptions): ProcessExecutor<Payload, Result> {
  return new ProcessRuntime<Payload, Result>(resolveProcessExecutorOptions(options));
}
