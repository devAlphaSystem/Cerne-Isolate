/**
 * Identifies a stable public executor failure category.
 */
export type ProcessErrorCode = "PROCESS_TIMEOUT" | "PROCESS_ABORTED" | "PROCESS_EXIT" | "PROCESS_QUEUE_FULL" | "PROCESS_SERIALIZATION" | "PROCESS_HANDLER" | "PROCESS_PROTOCOL" | "PROCESS_EXECUTOR_CLOSED";

/**
 * Identifies the IPC direction whose value could not be serialized.
 */
export type ProcessSerializationDirection = "request" | "result" | "error";

/**
 * Identifies the lifecycle phase in which a worker exited unexpectedly.
 */
export type ProcessExitPhase = "startup" | "execution";

/**
 * Identifies why an execution was aborted.
 */
export type ProcessAbortSource = "signal" | "shutdown";

/**
 * Identifies the strongest termination action requested before a child closed.
 */
export type ProcessTerminationStage = "natural" | "sigterm" | "sigkill";

/**
 * Describes an error thrown by a handler using only IPC-safe primitives.
 */
export interface SerializedProcessError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  cause?: SerializedProcessError;
}

/**
 * Reports that one process was created for an accepted task.
 */
export interface ProcessStartEvent {
  readonly type: "start";
  readonly taskId: number;
  readonly pid: number | null;
  readonly queuedMs: number;
}

/**
 * Reports the first terminal outcome observed for a task.
 */
export interface ProcessEndEvent {
  readonly type: "end";
  readonly taskId: number;
  readonly outcome: "success" | ProcessErrorCode;
  readonly durationMs: number;
}

/**
 * Confirms that a child and its IPC channel have closed.
 */
export interface ProcessCloseEvent {
  readonly type: "close";
  readonly taskId: number;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly termination: ProcessTerminationStage;
  readonly totalDurationMs: number;
}

/**
 * Provides lifecycle telemetry without including payloads, results, worker paths, or error details.
 */
export type ProcessExecutorEvent = ProcessStartEvent | ProcessEndEvent | ProcessCloseEvent;

/**
 * Receives optional lifecycle telemetry. Listener failures are isolated from task execution.
 */
export type ProcessEventListener = (event: ProcessExecutorEvent) => void | PromiseLike<void>;

/**
 * Configures a bounded disposable-process executor.
 */
export interface ProcessExecutorOptions {
  /** Supplies an absolute worker path or a file URL selected by trusted application code. */
  worker: string | URL;
  /** Limits children that have not yet emitted `close`. Defaults to 1. */
  concurrency?: number;
  /** Limits waiting tasks, excluding active children. Defaults to 100. */
  maxQueue?: number;
  /** Limits each dispatched task, including worker startup, in milliseconds. Zero disables the timeout. Defaults to 60 seconds. */
  timeoutMs?: number;
  /** Sets the grace period between termination signals in milliseconds. Defaults to 250. */
  killGraceMs?: number;
  /** Receives optional payload-free lifecycle events. */
  onEvent?: ProcessEventListener;
}

/**
 * Configures one submitted task.
 */
export interface ProcessRunOptions {
  /** Cancels a waiting or active task. */
  signal?: AbortSignal;
}

/**
 * Runs typed payloads in disposable child processes.
 */
export interface ProcessExecutor<Payload, Result> {
  /** Enqueues or immediately starts one task. */
  run(payload: Payload, options?: ProcessRunOptions): Promise<Result>;
  /** Stops admission, rejects queued work, terminates active children, and waits for every `close`. */
  close(): Promise<void>;
}

/**
 * Implements one process worker. Each child invokes the handler at most once.
 */
export type ProcessHandler<Payload, Result> = (payload: Payload) => Result | PromiseLike<Result>;
