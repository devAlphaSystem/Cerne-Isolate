import { ManagedChild, type ManagedChildHandlers } from "./child";
import { ProcessAbortedError, ProcessExecutorClosedError, type ProcessExecutorError, ProcessExitError, ProcessHandlerError, ProcessProtocolError, ProcessQueueFullError, ProcessSerializationError, ProcessTimeoutError } from "./errors";
import type { ResolvedPoolPolicy, ResolvedProcessOptions } from "./options";
import { cloneIpcValue, parseChildMessage } from "./protocol";
import { elapsedMilliseconds, startTimer, type MonotonicTimestamp } from "./timing";
import type { ProcessExecutionMode, ProcessExecutor, ProcessExecutorEvent, ProcessRecycleReason, ProcessRunOptions } from "./types";

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

interface ActiveTask<Payload, Result> {
  job: QueuedTask<Payload, Result>;
  child: ManagedChild;
  startedAt: MonotonicTimestamp;
  outcome: TaskOutcome<Result> | null;
  settled: boolean;
  timeout?: NodeJS.Timeout;
  abortListener?: () => void;
}

type RuntimeState = "open" | "closing" | "closed";

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

/**
 * Implements the admission, queue, dispatch, cancellation and shutdown rules shared by both
 * execution modes. The only difference between them is the child lifecycle policy: a disposable
 * runtime forks one process per task and terminates it, while a pooled runtime keeps a healthy
 * process for the next task and discards it on any failure or configured limit.
 */
export class ProcessRuntime<Payload, Result> implements ProcessExecutor<Payload, Result> {
  readonly #options: ResolvedProcessOptions;
  readonly #pool: ResolvedPoolPolicy | null;
  readonly #mode: ProcessExecutionMode;
  readonly #handlers: ManagedChildHandlers;
  readonly #queue: Array<QueuedTask<Payload, Result>> = [];
  readonly #tasks = new Map<number, ActiveTask<Payload, Result>>();
  readonly #children = new Map<number, ManagedChild>();
  readonly #idle: ManagedChild[] = [];
  #state: RuntimeState = "open";
  #nextTaskId = 1;
  #nextProcessId = 1;
  #closePromise?: Promise<void>;
  #resolveClose?: () => void;

  public constructor(options: ResolvedProcessOptions) {
    this.#options = options;
    this.#pool = options.pool ?? null;
    this.#mode = this.#pool === null ? "disposable" : "reusable";
    this.#handlers = {
      onMessage: (child, message): void => {
        this.#onChildMessage(child, message);
      },
      onLifecycleError: (child, error): void => {
        this.#onChildLifecycleError(child, error);
      },
      onSendError: (child, taskId, error): void => {
        this.#onChildSendError(child, taskId, error);
      },
      onClose: (child, exitCode, signal): void => {
        this.#onChildClose(child, exitCode, signal);
      },
    };
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
    if (!this.#canDispatch() && this.#queue.length >= this.#options.maxQueue) {
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
    if (!this.#canDispatch() && this.#queue.length >= this.#options.maxQueue) {
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
      if (this.#canDispatch()) {
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
    for (const task of [...this.#tasks.values()]) {
      this.#claim(task, { type: "reject", error: new ProcessAbortedError("shutdown") }, true);
    }
    for (const child of [...this.#children.values()]) {
      this.#discard(child, this.#pool === null ? null : "shutdown", child.taskId !== null);
    }
    this.#finishCloseIfReady();
    return this.#closePromise;
  }

  /**
   * Reports whether a task submitted now would start immediately. A pooled runtime dispatches to
   * an idle process before creating another one, and processes still waiting for `close` keep
   * occupying their concurrency slot in both modes.
   */
  #canDispatch(): boolean {
    return this.#idle.length > 0 || this.#children.size < this.#options.concurrency;
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
    const reused = this.#idle.pop();
    let child: ManagedChild;
    if (reused !== undefined) {
      child = reused;
      child.clearIdleTimer();
    } else {
      const processId = this.#nextProcessId++;
      try {
        child = new ManagedChild({ processId, workerPath: this.#options.workerPath, mode: this.#mode, killGraceMs: this.#options.killGraceMs }, this.#handlers);
      } catch (error) {
        job.reject(new ProcessExitError(null, null, "startup", errorOptionsFromReason(error)));
        return;
      }
      this.#children.set(processId, child);
      if (this.#pool !== null) {
        this.#emit({ type: "spawn", processId, pid: child.pid });
        this.#armLifetimeTimer(child);
      }
    }

    const task: ActiveTask<Payload, Result> = { job, child, startedAt: startTimer(), outcome: null, settled: false };
    this.#tasks.set(job.taskId, task);
    child.taskId = job.taskId;
    child.requestSent = false;

    if (this.#options.timeoutMs > 0) {
      const remaining = Math.max(0, this.#options.timeoutMs - elapsedMilliseconds(task.startedAt));
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

    this.#emit({ type: "start", processId: child.processId, taskId: job.taskId, pid: child.pid, queuedMs, reused: reused !== undefined });
    if (child.ready && task.outcome === null) {
      child.send(job.taskId, job.ipcPayload);
    }
    if (isSignalAborted(job.signal)) {
      this.#claim(task, { type: "reject", error: new ProcessAbortedError("signal", errorOptionsFromReason(readSignalReason(job.signal))) }, true);
    }
  }

  #onChildMessage(child: ManagedChild, rawMessage: unknown): void {
    if (child.closed) {
      return;
    }
    const message = parseChildMessage(rawMessage);
    if (message === null) {
      this.#violation(child);
      return;
    }
    if (message.type === "ready") {
      if (child.ready || child.requestSent || !message.modes.includes(this.#mode)) {
        this.#violation(child);
        return;
      }
      child.ready = true;
      const pending = this.#taskOf(child);
      if (pending !== null && pending.outcome === null) {
        child.send(pending.job.taskId, pending.job.ipcPayload);
      }
      return;
    }
    if (message.type === "protocol-error") {
      this.#violation(child);
      return;
    }
    const task = this.#taskOf(child);
    if (task !== null && task.outcome !== null) {
      return;
    }
    if (task === null || !child.requestSent || message.taskId !== child.taskId) {
      this.#violation(child);
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

  #onChildLifecycleError(child: ManagedChild, error: Error): void {
    child.lifecycleError ??= error;
    if (child.closed) {
      return;
    }
    const task = this.#taskOf(child);
    if (task === null) {
      this.#discard(child, this.#discardReason(), true);
      return;
    }
    if (task.outcome === null) {
      this.#claim(task, { type: "reject", error: new ProcessExitError(null, null, child.ready ? "execution" : "startup", { cause: error }) }, true);
    }
  }

  #onChildSendError(child: ManagedChild, taskId: number, error: unknown): void {
    if (child.closed) {
      return;
    }
    const task = this.#tasks.get(taskId);
    if (task === undefined || task.child !== child || task.outcome !== null) {
      return;
    }
    const failure = isSerializationFailure(error) ? new ProcessSerializationError("request", errorOptionsFromReason(error)) : new ProcessExitError(null, null, "execution", errorOptionsFromReason(error));
    this.#claim(task, { type: "reject", error: failure }, true);
  }

  #onChildClose(child: ManagedChild, exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.#children.delete(child.processId);
    this.#removeIdle(child);
    const task = this.#taskOf(child);
    if (task !== null && task.outcome === null) {
      this.#claim(task, { type: "reject", error: new ProcessExitError(exitCode, signal, child.ready ? "execution" : "startup", errorOptionsFromReason(child.lifecycleError)) }, false);
    }
    this.#emit({
      type: "close",
      processId: child.processId,
      taskId: child.taskId,
      pid: child.pid,
      exitCode,
      signal,
      termination: child.terminationStage,
      totalDurationMs: child.lifetimeMs,
      jobs: child.jobs,
    });
    if (task !== null) {
      this.#settle(task);
    }

    if (this.#state === "open") {
      this.#drain();
    } else {
      this.#finishCloseIfReady();
    }
  }

  /**
   * Records the first terminal outcome of a task. A pooled success releases the process and
   * settles right away, because the child already reported the task as finished. Every other
   * outcome discards the process and settles only after its `close`, so a caller never observes
   * a failure while the process that produced it may still be running.
   */
  #claim(task: ActiveTask<Payload, Result>, outcome: TaskOutcome<Result>, immediate: boolean): boolean {
    if (task.outcome !== null) {
      return false;
    }
    task.outcome = outcome;
    this.#clearDeadlineAndAbort(task);
    const child = task.child;
    this.#emit({
      type: "end",
      processId: child.processId,
      taskId: task.job.taskId,
      outcome: outcome.type === "resolve" ? "success" : outcome.error.code,
      durationMs: elapsedMilliseconds(task.startedAt),
    });
    if (outcome.type === "resolve" && this.#pool !== null) {
      child.jobs += 1;
      this.#settle(task);
      this.#release(child);
      return true;
    }
    this.#discard(child, this.#discardReason(), immediate);
    return true;
  }

  #settle(task: ActiveTask<Payload, Result>): void {
    const outcome = task.outcome;
    if (task.settled || outcome === null) {
      return;
    }
    task.settled = true;
    this.#tasks.delete(task.job.taskId);
    if (task.child.taskId === task.job.taskId) {
      task.child.taskId = null;
      task.child.requestSent = false;
    }
    if (outcome.type === "resolve") {
      task.job.resolve(outcome.result);
    } else {
      task.job.reject(outcome.error);
    }
  }

  /** Returns a healthy pooled process to rotation, or recycles it when a limit was reached. */
  #release(child: ManagedChild): void {
    if (child.closed || child.retired) {
      return;
    }
    const reason = this.#recycleReason(child);
    if (reason !== null) {
      this.#discard(child, reason, false);
      return;
    }
    this.#idle.push(child);
    this.#drain();
    if (child.closed || child.retired || child.taskId !== null) {
      return;
    }
    this.#emit({ type: "idle", processId: child.processId, pid: child.pid, jobs: child.jobs });
    this.#armIdleTimer(child);
  }

  /** Removes a process from rotation and terminates it. `reason` is null in disposable mode. */
  #discard(child: ManagedChild, reason: ProcessRecycleReason | null, immediate: boolean): void {
    const announced = child.retired;
    child.retired = true;
    this.#removeIdle(child);
    child.clearIdleTimer();
    if (child.closed) {
      return;
    }
    if (!announced && reason !== null) {
      this.#emit({ type: "recycle", processId: child.processId, pid: child.pid, reason, jobs: child.jobs });
    }
    child.terminate(immediate);
  }

  #discardReason(): ProcessRecycleReason | null {
    if (this.#pool === null) {
      return null;
    }
    return this.#state === "open" ? "failure" : "shutdown";
  }

  #recycleReason(child: ManagedChild): ProcessRecycleReason | null {
    const pool = this.#pool;
    if (pool === null) {
      return null;
    }
    if (this.#state !== "open") {
      return "shutdown";
    }
    if (pool.maxJobsPerProcess > 0 && child.jobs >= pool.maxJobsPerProcess) {
      return "max-jobs";
    }
    if (pool.maxLifetimeMs > 0 && child.lifetimeMs >= pool.maxLifetimeMs) {
      return "max-lifetime";
    }
    return null;
  }

  #armIdleTimer(child: ManagedChild): void {
    const pool = this.#pool;
    if (pool === null) {
      return;
    }
    child.idleTimer = setTimeout(() => {
      if (child.closed || child.retired || child.taskId !== null) {
        return;
      }
      this.#discard(child, "idle", false);
    }, pool.idleTimeoutMs);
    child.idleTimer.unref();
  }

  #armLifetimeTimer(child: ManagedChild): void {
    const pool = this.#pool;
    if (pool === null || pool.maxLifetimeMs === 0) {
      return;
    }
    child.lifetimeTimer = setTimeout(() => {
      if (child.closed || child.retired || child.taskId !== null) {
        return;
      }
      this.#discard(child, "max-lifetime", false);
    }, pool.maxLifetimeMs);
    child.lifetimeTimer.unref();
  }

  #removeIdle(child: ManagedChild): void {
    const index = this.#idle.indexOf(child);
    if (index !== -1) {
      this.#idle.splice(index, 1);
    }
  }

  #taskOf(child: ManagedChild): ActiveTask<Payload, Result> | null {
    return child.taskId === null ? null : (this.#tasks.get(child.taskId) ?? null);
  }

  #violation(child: ManagedChild): void {
    const task = this.#taskOf(child);
    if (task !== null && task.outcome === null) {
      this.#claim(task, { type: "reject", error: new ProcessProtocolError() }, true);
      return;
    }
    this.#discard(child, this.#discardReason(), true);
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

  #drain(): void {
    while (this.#state === "open" && this.#queue.length > 0 && this.#canDispatch()) {
      const job = this.#queue.shift();
      if (job === undefined) {
        return;
      }
      this.#start(job);
    }
  }

  #finishCloseIfReady(): void {
    if (this.#state !== "closing" || this.#children.size > 0 || this.#tasks.size > 0) {
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
