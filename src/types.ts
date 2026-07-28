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
 * Identifies the lifecycle contract negotiated with a worker process.
 */
export type ProcessExecutionMode = "disposable" | "reusable";

/**
 * Identifies why a pooled process stopped accepting new tasks.
 */
export type ProcessRecycleReason = "failure" | "max-jobs" | "max-lifetime" | "idle" | "shutdown";

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
 * Reports that a child process was created. Only the pool emits it, because a disposable
 * execution already reports its single process through `start`.
 */
export interface ProcessSpawnEvent {
  readonly type: "spawn";
  readonly processId: number;
  readonly pid: number | null;
}

/**
 * Reports that one process began an accepted task.
 */
export interface ProcessStartEvent {
  readonly type: "start";
  readonly processId: number;
  readonly taskId: number;
  readonly pid: number | null;
  readonly queuedMs: number;
  readonly reused: boolean;
}

/**
 * Reports the first terminal outcome observed for a task.
 */
export interface ProcessEndEvent {
  readonly type: "end";
  readonly processId: number;
  readonly taskId: number;
  readonly outcome: "success" | ProcessErrorCode;
  readonly durationMs: number;
}

/**
 * Reports that a pooled process finished a task and is waiting for the next one.
 */
export interface ProcessIdleEvent {
  readonly type: "idle";
  readonly processId: number;
  readonly pid: number | null;
  readonly jobs: number;
}

/**
 * Reports that a pooled process was removed from rotation and is being terminated.
 */
export interface ProcessRecycleEvent {
  readonly type: "recycle";
  readonly processId: number;
  readonly pid: number | null;
  readonly reason: ProcessRecycleReason;
  readonly jobs: number;
}

/**
 * Confirms that a child and its IPC channel have closed. `taskId` names the task the process
 * still owned at that moment: always a number for a disposable execution, and `null` when a
 * pooled process closes while idle or while being recycled.
 */
export interface ProcessCloseEvent {
  readonly type: "close";
  readonly processId: number;
  readonly taskId: number | null;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly termination: ProcessTerminationStage;
  readonly totalDurationMs: number;
  readonly jobs: number;
}

/**
 * Provides lifecycle telemetry without including payloads, results, worker paths, or error details.
 */
export type ProcessExecutorEvent = ProcessSpawnEvent | ProcessStartEvent | ProcessEndEvent | ProcessIdleEvent | ProcessRecycleEvent | ProcessCloseEvent;

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
 * Configures a bounded pool that reuses worker processes between tasks.
 */
export interface ProcessPoolOptions extends ProcessExecutorOptions {
  /** Terminates a process after this many milliseconds without work. Required, between 1 and 2147483647. */
  idleTimeoutMs: number;
  /** Recycles a process after this many successful tasks. Zero disables the limit. Defaults to 10. */
  maxJobsPerProcess?: number;
  /** Recycles a process once its lifetime reaches this value, never interrupting a healthy task. Zero disables the limit. Defaults to 600000. */
  maxLifetimeMs?: number;
}

/**
 * Configures one submitted task.
 */
export interface ProcessRunOptions {
  /** Cancels a waiting or active task. */
  signal?: AbortSignal;
}

/**
 * Runs typed payloads in child processes.
 */
export interface ProcessExecutor<Payload, Result> {
  /** Enqueues or immediately starts one task. */
  run(payload: Payload, options?: ProcessRunOptions): Promise<Result>;
  /** Stops admission, rejects queued work, terminates every child, and waits for every `close`. */
  close(): Promise<void>;
}

/**
 * Runs typed payloads in reusable child processes. The surface is the same one returned by
 * `createProcessExecutor`, so both modes are interchangeable at the call site.
 */
export type ProcessPool<Payload, Result> = ProcessExecutor<Payload, Result>;

/**
 * Implements one process worker. A disposable child invokes the handler once; a pooled child
 * invokes it once per assigned task, never concurrently.
 */
export type ProcessHandler<Payload, Result> = (payload: Payload) => Result | PromiseLike<Result>;
