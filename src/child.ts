import { fork, type ChildProcess } from "node:child_process";

import { protocolEnvelope, type RunMessage, type ShutdownMessage } from "./protocol";
import { elapsedMilliseconds, startTimer, type MonotonicTimestamp } from "./timing";
import type { ProcessExecutionMode, ProcessTerminationStage } from "./types";

type InternalTerminationStage = "none" | "graceful" | "sigterm" | "sigkill";

/**
 * Receives the raw transitions of one child process. The runtime owns every protocol and
 * scheduling decision; this interface only reports what the operating system and the IPC
 * channel made observable.
 */
export interface ManagedChildHandlers {
  onMessage(child: ManagedChild, message: unknown): void;
  onLifecycleError(child: ManagedChild, error: Error): void;
  onSendError(child: ManagedChild, taskId: number, error: unknown): void;
  onClose(child: ManagedChild, exitCode: number | null, signal: NodeJS.Signals | null): void;
}

export interface ManagedChildOptions {
  processId: number;
  workerPath: string;
  mode: ProcessExecutionMode;
  killGraceMs: number;
}

/**
 * Owns one forked worker: its IPC listeners, its request delivery, the timers attached to its
 * lifetime and the escalation from a cooperative exit to `SIGTERM` and `SIGKILL`. The bookkeeping
 * fields are written by the runtime, which is the single place where the state machine lives.
 */
export class ManagedChild {
  public readonly processId: number;
  public readonly pid: number | null;
  /** Marks the handshake as accepted by the runtime. */
  public ready = false;
  /** Names the task this child currently owns, or `null` while it is idle. */
  public taskId: number | null = null;
  /** Marks that the run message of the current task already reached the IPC channel. */
  public requestSent = false;
  /** Counts tasks this child completed successfully. */
  public jobs = 0;
  /** Marks a child that must never receive another task. */
  public retired = false;
  public closed = false;
  public lifecycleError?: Error;
  public idleTimer?: NodeJS.Timeout;
  public lifetimeTimer?: NodeJS.Timeout;

  readonly #child: ChildProcess;
  readonly #handlers: ManagedChildHandlers;
  readonly #mode: ProcessExecutionMode;
  readonly #killGraceMs: number;
  readonly #spawnedAt: MonotonicTimestamp;
  #stage: InternalTerminationStage = "none";
  #terminationTimer?: NodeJS.Timeout;

  public constructor(options: ManagedChildOptions, handlers: ManagedChildHandlers) {
    this.processId = options.processId;
    this.#handlers = handlers;
    this.#mode = options.mode;
    this.#killGraceMs = options.killGraceMs;
    this.#spawnedAt = startTimer();
    this.#child = fork(options.workerPath, [], {
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      detached: false,
      execArgv: [],
    });
    this.pid = this.#child.pid ?? null;

    this.#child.on("message", (message: unknown) => {
      this.#handlers.onMessage(this, message);
    });
    this.#child.on("error", (error) => {
      this.#handlers.onLifecycleError(this, error);
    });
    this.#child.once("close", (exitCode, signal) => {
      this.#onClose(exitCode, signal);
    });
  }

  /** Reports how long this process has existed, from `fork` to the current instant. */
  public get lifetimeMs(): number {
    return elapsedMilliseconds(this.#spawnedAt);
  }

  /** Reports the strongest termination action requested so far. */
  public get terminationStage(): ProcessTerminationStage {
    return this.#stage === "sigkill" ? "sigkill" : this.#stage === "sigterm" ? "sigterm" : "natural";
  }

  /** Hands one run request to the IPC channel. Delivery failures arrive through `onSendError`. */
  public send<Payload>(taskId: number, payload: Payload): void {
    const message: RunMessage<Payload> = { ...protocolEnvelope(), type: "run", mode: this.#mode, taskId, payload };
    this.requestSent = true;
    try {
      this.#child.send(message, (error) => {
        if (error !== null) {
          this.#handlers.onSendError(this, taskId, error);
        }
      });
    } catch (error) {
      this.#handlers.onSendError(this, taskId, error);
    }
  }

  public clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /**
   * Terminates the child. The graceful path lets a disposable worker exit by itself after its
   * response and asks a reusable worker to disconnect, then escalates through `SIGTERM` and
   * `SIGKILL`. The immediate path skips straight to the signals. Only `close` confirms the end.
   */
  public terminate(immediate: boolean): void {
    if (this.closed || this.#stage === "sigkill" || (immediate && this.#stage === "sigterm")) {
      return;
    }
    if (!immediate) {
      if (this.#stage !== "none") {
        return;
      }
      this.#stage = "graceful";
      if (this.#mode === "reusable") {
        this.#requestCooperativeExit();
      }
      this.#scheduleTermination(() => {
        this.terminate(true);
      });
      return;
    }

    if (this.#terminationTimer !== undefined) {
      clearTimeout(this.#terminationTimer);
      this.#terminationTimer = undefined;
    }
    try {
      this.#child.channel?.unref();
    } catch {
      // Releasing the IPC channel is best-effort; signal escalation still follows.
    }
    this.#stage = "sigterm";
    try {
      this.#child.kill("SIGTERM");
    } catch {
      // The close event remains the only termination confirmation.
    }
    this.#scheduleTermination(() => {
      if (this.closed) {
        return;
      }
      this.#stage = "sigkill";
      try {
        this.#child.kill("SIGKILL");
      } catch {
        // The runtime deliberately keeps waiting for close instead of claiming an unconfirmed shutdown.
      }
    });
  }

  /** Clears every timer this child owns. Called on close and on runtime shutdown. */
  public clearTimers(): void {
    this.clearIdleTimer();
    if (this.lifetimeTimer !== undefined) {
      clearTimeout(this.lifetimeTimer);
      this.lifetimeTimer = undefined;
    }
    if (this.#terminationTimer !== undefined) {
      clearTimeout(this.#terminationTimer);
      this.#terminationTimer = undefined;
    }
  }

  #requestCooperativeExit(): void {
    const message: ShutdownMessage = { ...protocolEnvelope(), type: "shutdown" };
    try {
      this.#child.send(message, () => {
        // A reusable worker that cannot receive the request is terminated by the escalation timer.
      });
    } catch {
      // Same fallback: the escalation timer already covers an unreachable channel.
    }
  }

  #scheduleTermination(callback: () => void): void {
    this.#terminationTimer = setTimeout(callback, this.#killGraceMs);
    this.#terminationTimer.unref();
  }

  #onClose(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.clearTimers();
    this.#handlers.onClose(this, exitCode, signal);
  }
}
