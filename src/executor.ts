import { fork, type ChildProcess } from "node:child_process";

import { ProcessAbortedError, ProcessExecutorClosedError, type ProcessExecutorError, ProcessExitError, ProcessHandlerError, ProcessProtocolError, ProcessQueueFullError, ProcessSerializationError, ProcessTimeoutError } from "./errors";
import { resolveProcessExecutorOptions, type ResolvedProcessExecutorOptions } from "./options";
import { cloneIpcValue, parseChildMessage, protocolEnvelope, type RunMessage } from "./protocol";
import { elapsedMilliseconds, startTimer, type MonotonicTimestamp } from "./timing";
import type { ProcessExecutor, ProcessExecutorEvent, ProcessExecutorOptions, ProcessRunOptions, ProcessTerminationStage } from "./types";

interface QueuedTask<Payload, Result> {
  taskId: number;
  ipcPayload: Payload;
  enqueuedAt: MonotonicTimestamp;
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve: (result: Result) => void;
  reject: (error: unknown) => void;
}

type TaskOutcome<Result> = { type: "resolve"; result: Result } | { type: "reject"; error: ProcessExecutorError };
type InternalTerminationStage = "none" | "graceful" | "sigterm" | "sigkill";

interface ActiveTask<Payload, Result> {
  job: QueuedTask<Payload, Result>;
  child: ChildProcess;
  pid: number | null;
  startedAt: MonotonicTimestamp;
  ready: boolean;
  requestSent: boolean;
  closed: boolean;
  outcome: TaskOutcome<Result> | null;
  lifecycleError?: Error;
  timeout?: NodeJS.Timeout;
  terminationTimer?: NodeJS.Timeout;
  abortListener?: () => void;
  terminationStage: InternalTerminationStage;
}

type ExecutorState = "open" | "closing" | "closed";

const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const REASON_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")?.get;
const ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;

function readSignalAborted(signal: AbortSignal): boolean {
  if (ABORTED_GETTER === undefined) {
    throw new TypeError("AbortSignal is not supported by this Node.js runtime.");
  }
  return Reflect.apply(ABORTED_GETTER, signal, []) as boolean;
}

function readSignalReason(signal: AbortSignal | undefined): unknown {
  if (signal === undefined || REASON_GETTER === undefined) {
    return undefined;
  }
  return Reflect.apply(REASON_GETTER, signal, []) as unknown;
}

function addSignalAbortListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(ADD_EVENT_LISTENER, signal, ["abort", listener, { once: true }]);
}

function removeSignalAbortListener(signal: AbortSignal, listener: () => void): void {
  try {
    Reflect.apply(REMOVE_EVENT_LISTENER, signal, ["abort", listener]);
  } catch {
    // A validated native signal should not fail removal; cleanup must remain exception-safe if the runtime is modified.
  }
}

function errorOptionsFromReason(reason: unknown): ErrorOptions | undefined {
  return reason === undefined ? undefined : { cause: reason };
}

function validateRunOptions(options: ProcessRunOptions | undefined): AbortSignal | undefined {
  if (options === undefined) {
    return undefined;
  }
  if (typeof options !== "object" || options === null) {
    throw new TypeError("run options must be an object.");
  }
  const { signal } = options;
  if (signal === undefined) {
    return undefined;
  }
  if (typeof signal !== "object" || signal === null) {
    throw new TypeError("signal must be an AbortSignal.");
  }
  try {
    readSignalAborted(signal);
  } catch {
    throw new TypeError("signal must be an AbortSignal.");
  }
  return signal;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && readSignalAborted(signal);
}

function isSerializationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as Error & { code?: unknown }).code;
  return code === "ERR_INVALID_ARG_TYPE" || code === "ERR_BUFFER_TOO_LARGE" || error.name === "DataCloneError";
}

class DisposableProcessExecutor<Payload, Result> implements ProcessExecutor<Payload, Result> {
  readonly #options: ResolvedProcessExecutorOptions;
  readonly #queue: Array<QueuedTask<Payload, Result>> = [];
  readonly #active = new Map<number, ActiveTask<Payload, Result>>();
  #state: ExecutorState = "open";
  #nextTaskId = 1;
  #closePromise?: Promise<void>;
  #resolveClose?: () => void;

  public constructor(options: ResolvedProcessExecutorOptions) {
    this.#options = options;
  }

  public run(payload: Payload, options?: ProcessRunOptions): Promise<Result> {
    if (this.#state !== "open") {
      return Promise.reject(new ProcessExecutorClosedError());
    }

    let signal: AbortSignal | undefined;
    try {
      signal = validateRunOptions(options);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#state !== "open") {
      return Promise.reject(new ProcessExecutorClosedError());
    }
    const initiallyAborted = isSignalAborted(signal);
    if (this.#state !== "open") {
      return Promise.reject(new ProcessExecutorClosedError());
    }
    if (initiallyAborted) {
      return Promise.reject(new ProcessAbortedError("signal", errorOptionsFromReason(readSignalReason(signal))));
    }
    if (this.#active.size >= this.#options.concurrency && this.#queue.length >= this.#options.maxQueue) {
      return Promise.reject(new ProcessQueueFullError(this.#options.maxQueue));
    }

    let ipcPayload: Payload;
    try {
      ipcPayload = cloneIpcValue(payload);
    } catch (error) {
      if (this.#state !== "open") {
        return Promise.reject(new ProcessExecutorClosedError());
      }
      return Promise.reject(new ProcessSerializationError("request", errorOptionsFromReason(error)));
    }
    if (this.#state !== "open") {
      return Promise.reject(new ProcessExecutorClosedError());
    }
    const abortedAfterSnapshot = isSignalAborted(signal);
    if (this.#state !== "open") {
      return Promise.reject(new ProcessExecutorClosedError());
    }
    if (abortedAfterSnapshot) {
      return Promise.reject(new ProcessAbortedError("signal", errorOptionsFromReason(readSignalReason(signal))));
    }
    if (this.#active.size >= this.#options.concurrency && this.#queue.length >= this.#options.maxQueue) {
      return Promise.reject(new ProcessQueueFullError(this.#options.maxQueue));
    }

    const taskId = this.#nextTaskId++;
    return new Promise<Result>((resolve, reject) => {
      const job: QueuedTask<Payload, Result> = {
        taskId,
        ipcPayload,
        enqueuedAt: startTimer(),
        ...(signal === undefined ? {} : { signal }),
        resolve,
        reject,
      };
      if (this.#active.size < this.#options.concurrency) {
        this.#start(job);
      } else {
        this.#enqueue(job);
      }
    });
  }

  public close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }

    this.#state = "closing";
    this.#closePromise = new Promise<void>((resolve) => {
      this.#resolveClose = resolve;
    });

    for (const job of this.#queue.splice(0)) {
      this.#removeQueuedAbortListener(job);
      job.reject(new ProcessAbortedError("shutdown"));
    }
    for (const task of this.#active.values()) {
      this.#claim(task, { type: "reject", error: new ProcessAbortedError("shutdown") }, true);
      this.#beginTermination(task, true);
    }
    this.#finishCloseIfReady();
    return this.#closePromise;
  }

  #enqueue(job: QueuedTask<Payload, Result>): void {
    this.#queue.push(job);
    if (job.signal !== undefined) {
      job.abortListener = (): void => {
        this.#abortQueued(job);
      };
      try {
        addSignalAbortListener(job.signal, job.abortListener);
      } catch (error) {
        const index = this.#queue.indexOf(job);
        if (index !== -1) {
          this.#queue.splice(index, 1);
        }
        job.abortListener = undefined;
        job.reject(new ProcessAbortedError("signal", errorOptionsFromReason(error)));
        return;
      }
      if (isSignalAborted(job.signal)) {
        this.#abortQueued(job);
        return;
      }
    }
  }

  #abortQueued(job: QueuedTask<Payload, Result>): void {
    const index = this.#queue.indexOf(job);
    if (index === -1) {
      return;
    }
    this.#queue.splice(index, 1);
    this.#removeQueuedAbortListener(job);
    job.reject(new ProcessAbortedError("signal", errorOptionsFromReason(readSignalReason(job.signal))));
    this.#drain();
  }

  #removeQueuedAbortListener(job: QueuedTask<Payload, Result>): void {
    if (job.signal !== undefined && job.abortListener !== undefined) {
      removeSignalAbortListener(job.signal, job.abortListener);
      job.abortListener = undefined;
    }
  }

  #start(job: QueuedTask<Payload, Result>): void {
    this.#removeQueuedAbortListener(job);
    if (this.#state !== "open") {
      job.reject(new ProcessAbortedError("shutdown"));
      return;
    }
    if (isSignalAborted(job.signal)) {
      job.reject(new ProcessAbortedError("signal", errorOptionsFromReason(readSignalReason(job.signal))));
      return;
    }
    const queuedMs = elapsedMilliseconds(job.enqueuedAt);
    const startedAt = startTimer();
    let child: ChildProcess;
    try {
      child = fork(this.#options.workerPath, [], {
        serialization: "advanced",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        detached: false,
        execArgv: [],
      });
    } catch (error) {
      job.reject(new ProcessExitError(null, null, "startup", errorOptionsFromReason(error)));
      return;
    }

    const task: ActiveTask<Payload, Result> = {
      job,
      child,
      pid: child.pid ?? null,
      startedAt,
      ready: false,
      requestSent: false,
      closed: false,
      outcome: null,
      terminationStage: "none",
    };
    this.#active.set(job.taskId, task);

    child.on("message", (message: unknown) => {
      this.#onMessage(task, message);
    });
    child.on("error", (error) => {
      this.#onChildError(task, error);
    });
    child.once("close", (code, signal) => {
      this.#onClose(task, code, signal);
    });

    if (this.#options.timeoutMs > 0) {
      const remaining = Math.max(0, this.#options.timeoutMs - elapsedMilliseconds(startedAt));
      task.timeout = setTimeout(() => {
        this.#claim(task, { type: "reject", error: new ProcessTimeoutError(this.#options.timeoutMs) }, true);
      }, remaining);
      task.timeout.unref();
    }
    if (job.signal !== undefined) {
      task.abortListener = (): void => {
        this.#claim(task, { type: "reject", error: new ProcessAbortedError("signal", errorOptionsFromReason(readSignalReason(job.signal))) }, true);
      };
      try {
        addSignalAbortListener(job.signal, task.abortListener);
      } catch (error) {
        this.#claim(task, { type: "reject", error: new ProcessAbortedError("signal", errorOptionsFromReason(error)) }, true);
      }
    }

    this.#emit({ type: "start", taskId: job.taskId, pid: task.pid, queuedMs });
    if (isSignalAborted(job.signal)) {
      this.#claim(task, { type: "reject", error: new ProcessAbortedError("signal", errorOptionsFromReason(readSignalReason(job.signal))) }, true);
    }
  }

  #onMessage(task: ActiveTask<Payload, Result>, rawMessage: unknown): void {
    if (task.closed || task.outcome !== null) {
      return;
    }
    const message = parseChildMessage(rawMessage);
    if (message === null) {
      this.#claim(task, { type: "reject", error: new ProcessProtocolError() }, true);
      return;
    }
    if (message.type === "ready") {
      if (task.ready || task.requestSent) {
        this.#claim(task, { type: "reject", error: new ProcessProtocolError() }, true);
        return;
      }
      task.ready = true;
      this.#sendRequest(task);
      return;
    }
    if (message.type === "protocol-error") {
      this.#claim(task, { type: "reject", error: new ProcessProtocolError() }, true);
      return;
    }
    if (!task.requestSent || message.taskId !== task.job.taskId) {
      this.#claim(task, { type: "reject", error: new ProcessProtocolError() }, true);
      return;
    }
    if (message.type === "result") {
      this.#claim(task, { type: "resolve", result: message.result as Result }, false);
    } else if (message.type === "handler-error") {
      this.#claim(task, { type: "reject", error: new ProcessHandlerError(message.error) }, false);
    } else {
      this.#claim(task, { type: "reject", error: new ProcessSerializationError(message.direction) }, false);
    }
  }

  #sendRequest(task: ActiveTask<Payload, Result>): void {
    const message: RunMessage<Payload> = {
      ...protocolEnvelope(),
      type: "run",
      taskId: task.job.taskId,
      payload: task.job.ipcPayload,
    };
    task.requestSent = true;
    try {
      task.child.send(message, (error) => {
        if (error === null || task.outcome !== null || task.closed) {
          return;
        }
        const executorError = isSerializationFailure(error) ? new ProcessSerializationError("request", { cause: error }) : new ProcessExitError(null, null, "execution", { cause: error });
        this.#claim(task, { type: "reject", error: executorError }, true);
      });
    } catch (error) {
      const executorError = isSerializationFailure(error) ? new ProcessSerializationError("request", errorOptionsFromReason(error)) : new ProcessExitError(null, null, "execution", errorOptionsFromReason(error));
      this.#claim(task, { type: "reject", error: executorError }, true);
    }
  }

  #onChildError(task: ActiveTask<Payload, Result>, error: Error): void {
    task.lifecycleError ??= error;
    if (task.outcome === null && !task.closed) {
      this.#claim(task, { type: "reject", error: new ProcessExitError(null, null, task.ready ? "execution" : "startup", { cause: error }) }, true);
    }
  }

  #onClose(task: ActiveTask<Payload, Result>, code: number | null, signal: NodeJS.Signals | null): void {
    if (task.closed) {
      return;
    }
    task.closed = true;
    this.#clearTaskResources(task);
    const outcome: TaskOutcome<Result> = task.outcome ?? { type: "reject", error: new ProcessExitError(code, signal, task.ready ? "execution" : "startup", errorOptionsFromReason(task.lifecycleError)) };
    if (task.outcome === null) {
      this.#claim(task, outcome, false);
    }

    this.#active.delete(task.job.taskId);
    this.#emit({
      type: "close",
      taskId: task.job.taskId,
      pid: task.pid,
      exitCode: code,
      signal,
      termination: this.#publicTerminationStage(task.terminationStage),
      totalDurationMs: elapsedMilliseconds(task.startedAt),
    });

    if (outcome.type === "resolve") {
      task.job.resolve(outcome.result);
    } else {
      task.job.reject(outcome.error);
    }

    if (this.#state === "open") {
      this.#drain();
    } else {
      this.#finishCloseIfReady();
    }
  }

  #claim(task: ActiveTask<Payload, Result>, outcome: TaskOutcome<Result>, immediateTermination: boolean): boolean {
    if (task.outcome !== null) {
      return false;
    }
    task.outcome = outcome;
    this.#clearDeadlineAndAbort(task);
    this.#emit({
      type: "end",
      taskId: task.job.taskId,
      outcome: outcome.type === "resolve" ? "success" : outcome.error.code,
      durationMs: elapsedMilliseconds(task.startedAt),
    });
    if (!task.closed) {
      this.#beginTermination(task, immediateTermination);
    }
    return true;
  }

  #beginTermination(task: ActiveTask<Payload, Result>, immediate: boolean): void {
    if (task.closed || task.terminationStage === "sigkill" || (immediate && task.terminationStage === "sigterm")) {
      return;
    }
    if (!immediate) {
      if (task.terminationStage !== "none") {
        return;
      }
      task.terminationStage = "graceful";
      this.#scheduleTermination(task, () => {
        this.#beginTermination(task, true);
      });
      return;
    }

    if (task.terminationTimer !== undefined) {
      clearTimeout(task.terminationTimer);
      task.terminationTimer = undefined;
    }
    try {
      task.child.channel?.unref();
    } catch {
      // Releasing the IPC channel is best-effort; signal escalation still follows.
    }
    task.terminationStage = "sigterm";
    try {
      task.child.kill("SIGTERM");
    } catch {
      // The close event remains the only termination confirmation.
    }
    this.#scheduleTermination(task, () => {
      if (task.closed) {
        return;
      }
      task.terminationStage = "sigkill";
      try {
        task.child.kill("SIGKILL");
      } catch {
        // The executor deliberately keeps waiting for close instead of claiming an unconfirmed shutdown.
      }
    });
  }

  #scheduleTermination(task: ActiveTask<Payload, Result>, callback: () => void): void {
    task.terminationTimer = setTimeout(callback, this.#options.killGraceMs);
    task.terminationTimer.unref();
  }

  #clearDeadlineAndAbort(task: ActiveTask<Payload, Result>): void {
    if (task.timeout !== undefined) {
      clearTimeout(task.timeout);
      task.timeout = undefined;
    }
    if (task.job.signal !== undefined && task.abortListener !== undefined) {
      removeSignalAbortListener(task.job.signal, task.abortListener);
      task.abortListener = undefined;
    }
  }

  #clearTaskResources(task: ActiveTask<Payload, Result>): void {
    this.#clearDeadlineAndAbort(task);
    if (task.terminationTimer !== undefined) {
      clearTimeout(task.terminationTimer);
      task.terminationTimer = undefined;
    }
  }

  #publicTerminationStage(stage: InternalTerminationStage): ProcessTerminationStage {
    return stage === "sigkill" ? "sigkill" : stage === "sigterm" ? "sigterm" : "natural";
  }

  #drain(): void {
    while (this.#state === "open" && this.#active.size < this.#options.concurrency && this.#queue.length > 0) {
      const job = this.#queue.shift();
      if (job !== undefined) {
        this.#start(job);
      }
    }
  }

  #finishCloseIfReady(): void {
    if (this.#state !== "closing" || this.#active.size > 0) {
      return;
    }
    this.#state = "closed";
    this.#resolveClose?.();
    this.#resolveClose = undefined;
  }

  #emit(event: ProcessExecutorEvent): void {
    if (this.#options.onEvent === undefined) {
      return;
    }
    try {
      const pending = this.#options.onEvent(Object.freeze(event));
      if (pending !== undefined) {
        void Promise.resolve(pending).catch(() => undefined);
      }
    } catch {
      // Observability must never change execution, cleanup, or task settlement.
    }
  }
}

/**
 * Creates an executor that runs at most one typed task in each disposable child process.
 */
export function createProcessExecutor<Payload = unknown, Result = unknown>(options: ProcessExecutorOptions): ProcessExecutor<Payload, Result> {
  return new DisposableProcessExecutor<Payload, Result>(resolveProcessExecutorOptions(options));
}
