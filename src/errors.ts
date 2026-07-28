import type { ProcessAbortSource, ProcessErrorCode, ProcessExitPhase, ProcessSerializationDirection, SerializedProcessError } from "./types";

/**
 * Base class for stable executor failures.
 */
export class ProcessExecutorError extends Error {
  public readonly code: ProcessErrorCode;

  public constructor(code: ProcessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProcessExecutorError";
    this.code = code;
  }
}

export class ProcessTimeoutError extends ProcessExecutorError {
  public override readonly code = "PROCESS_TIMEOUT" as const;
  public readonly timeoutMs: number;

  public constructor(timeoutMs: number) {
    super("PROCESS_TIMEOUT", `Worker process exceeded the ${timeoutMs} ms timeout.`);
    this.name = "ProcessTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ProcessAbortedError extends ProcessExecutorError {
  public override readonly code = "PROCESS_ABORTED" as const;
  public readonly source: ProcessAbortSource;

  public constructor(source: ProcessAbortSource, options?: ErrorOptions) {
    super("PROCESS_ABORTED", source === "shutdown" ? "Process execution was aborted because the executor is closing." : "Process execution was aborted by its signal.", options);
    this.name = "ProcessAbortedError";
    this.source = source;
  }
}

export class ProcessExitError extends ProcessExecutorError {
  public override readonly code = "PROCESS_EXIT" as const;
  public readonly exitCode: number | null;
  public readonly signal: NodeJS.Signals | null;
  public readonly phase: ProcessExitPhase;

  public constructor(exitCode: number | null, signal: NodeJS.Signals | null, phase: ProcessExitPhase, options?: ErrorOptions) {
    const detail = signal !== null ? ` with signal ${signal}` : exitCode !== null ? ` with exit code ${exitCode}` : "";
    super("PROCESS_EXIT", `Worker process closed${detail} before returning a result.`, options);
    this.name = "ProcessExitError";
    this.exitCode = exitCode;
    this.signal = signal;
    this.phase = phase;
  }
}

export class ProcessQueueFullError extends ProcessExecutorError {
  public override readonly code = "PROCESS_QUEUE_FULL" as const;
  public readonly maxQueue: number;

  public constructor(maxQueue: number) {
    super("PROCESS_QUEUE_FULL", `Process queue is full at its limit of ${maxQueue} waiting tasks.`);
    this.name = "ProcessQueueFullError";
    this.maxQueue = maxQueue;
  }
}

export class ProcessSerializationError extends ProcessExecutorError {
  public override readonly code = "PROCESS_SERIALIZATION" as const;
  public readonly direction: ProcessSerializationDirection;

  public constructor(direction: ProcessSerializationDirection, options?: ErrorOptions) {
    super("PROCESS_SERIALIZATION", `The ${direction} value cannot be serialized for advanced IPC.`, options);
    this.name = "ProcessSerializationError";
    this.direction = direction;
  }
}

export class ProcessHandlerError extends ProcessExecutorError {
  public override readonly code = "PROCESS_HANDLER" as const;
  public readonly remoteError: SerializedProcessError;

  public constructor(remoteError: SerializedProcessError) {
    super("PROCESS_HANDLER", remoteError.message);
    this.name = "ProcessHandlerError";
    this.remoteError = remoteError;
  }
}

export class ProcessProtocolError extends ProcessExecutorError {
  public override readonly code = "PROCESS_PROTOCOL" as const;

  public constructor() {
    super("PROCESS_PROTOCOL", "Worker process violated the cerne-isolate IPC protocol.");
    this.name = "ProcessProtocolError";
  }
}

export class ProcessExecutorClosedError extends ProcessExecutorError {
  public override readonly code = "PROCESS_EXECUTOR_CLOSED" as const;

  public constructor() {
    super("PROCESS_EXECUTOR_CLOSED", "Process executor is closing or already closed.");
    this.name = "ProcessExecutorClosedError";
  }
}
