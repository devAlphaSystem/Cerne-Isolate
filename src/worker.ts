import { cloneIpcValue, parseParentMessage, protocolEnvelope, serializeProcessError, SUPPORTED_MODES, type RunMessage } from "./protocol";
import type { ProcessExecutionMode, ProcessHandler, SerializedProcessError } from "./types";

let handlerDefined = false;
let exiting = false;

function sendToParent(message: object): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (process.send === undefined || !process.connected) {
      reject(new Error("The worker IPC channel is not connected."));
      return;
    }
    try {
      process.send(message, (error) => {
        if (error === null) {
          resolve();
        } else {
          reject(error);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

function disconnectAndExit(exitCode: number): void {
  if (exiting) {
    return;
  }
  exiting = true;
  process.exitCode = exitCode;
  if (process.connected && process.disconnect !== undefined) {
    try {
      process.disconnect();
      return;
    } catch {
      // A direct exit is the fallback when the channel cannot be disconnected.
    }
  }
  process.exit(exitCode);
}

/**
 * Registers exactly one typed task handler in a process created by `createProcessExecutor` or
 * `createProcessPool`. The lifecycle is negotiated by the parent: a disposable process exits
 * after its first response, while a reusable process stays available after a successful result
 * and exits on any failure, on a shutdown request or when the IPC channel is disconnected.
 */
export function defineProcessHandler<Payload = unknown, Result = unknown>(handler: ProcessHandler<Payload, Result>): void {
  if (handlerDefined) {
    throw new Error("defineProcessHandler can only be called once in a worker process.");
  }
  if (typeof handler !== "function") {
    throw new TypeError("handler must be a function.");
  }
  if (process.send === undefined || !process.connected) {
    throw new Error("defineProcessHandler must run in a child process with an IPC channel.");
  }
  handlerDefined = true;

  process.once("disconnect", () => {
    process.exit(process.exitCode ?? 1);
  });

  let mode: ProcessExecutionMode | null = null;
  let busy = false;
  let lastTaskId = 0;
  let stopRequested = false;

  const onMessage = (rawMessage: unknown): void => {
    if (exiting) {
      return;
    }
    const message = parseParentMessage(rawMessage);
    if (message === null) {
      rejectProtocol();
      return;
    }
    if (message.type === "shutdown") {
      stopRequested = true;
      if (!busy) {
        finish(0);
      }
      return;
    }
    if (busy || stopRequested || message.taskId <= lastTaskId || (mode !== null && message.mode !== mode)) {
      rejectProtocol();
      return;
    }
    mode = message.mode;
    lastTaskId = message.taskId;
    busy = true;
    void execute(message).catch(() => {
      finish(1);
    });
  };

  function finish(exitCode: number): void {
    process.removeListener("message", onMessage);
    disconnectAndExit(exitCode);
  }

  async function respondAndFinish(message: object, exitCode: number): Promise<void> {
    try {
      await sendToParent(message);
    } finally {
      finish(exitCode);
    }
  }

  function rejectProtocol(): void {
    void respondAndFinish({ ...protocolEnvelope(), type: "protocol-error" }, 1).catch(() => {
      finish(1);
    });
  }

  async function execute(request: RunMessage<unknown>): Promise<void> {
    let result: Result;
    try {
      result = await handler(request.payload as Payload);
    } catch (error) {
      const serializedError = serializeProcessError(error);
      let ipcError: SerializedProcessError;
      try {
        ipcError = cloneIpcValue(serializedError);
      } catch {
        await respondAndFinish({ ...protocolEnvelope(), type: "serialization-error", taskId: request.taskId, direction: "error" }, 1);
        return;
      }
      await respondAndFinish({ ...protocolEnvelope(), type: "handler-error", taskId: request.taskId, error: ipcError }, 1);
      return;
    }

    let ipcResult: Result;
    try {
      ipcResult = cloneIpcValue(result);
    } catch {
      await respondAndFinish({ ...protocolEnvelope(), type: "serialization-error", taskId: request.taskId, direction: "result" }, 1);
      return;
    }

    const response = { ...protocolEnvelope(), type: "result", taskId: request.taskId, result: ipcResult };
    if (request.mode === "disposable") {
      await respondAndFinish(response, 0);
      return;
    }
    await sendToParent(response);
    busy = false;
    if (stopRequested) {
      finish(0);
    }
  }

  process.on("message", onMessage);
  void sendToParent({ ...protocolEnvelope(), type: "ready", modes: [...SUPPORTED_MODES] }).catch(() => {
    finish(1);
  });
}

export type { ProcessHandler } from "./types";
