import { cloneIpcValue, parseRunMessage, protocolEnvelope, serializeProcessError } from "./protocol";
import type { ProcessHandler, SerializedProcessError } from "./types";

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

async function sendFinalMessage(message: object, exitCode: number): Promise<void> {
  try {
    await sendToParent(message);
  } finally {
    disconnectAndExit(exitCode);
  }
}

/**
 * Registers exactly one typed task handler in a process created by `createProcessExecutor`.
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

  let consumed = false;
  const onMessage = (rawMessage: unknown): void => {
    if (consumed) {
      return;
    }
    const message = parseRunMessage(rawMessage);
    if (message === null) {
      consumed = true;
      process.removeListener("message", onMessage);
      void sendFinalMessage({ ...protocolEnvelope(), type: "protocol-error" }, 1).catch(() => {
        disconnectAndExit(1);
      });
      return;
    }

    consumed = true;
    process.removeListener("message", onMessage);
    void (async () => {
      let result: Result;
      try {
        result = await handler(message.payload as Payload);
      } catch (error) {
        const serializedError = serializeProcessError(error);
        let ipcError: SerializedProcessError;
        try {
          ipcError = cloneIpcValue(serializedError);
        } catch {
          await sendFinalMessage({ ...protocolEnvelope(), type: "serialization-error", taskId: message.taskId, direction: "error" }, 1);
          return;
        }
        await sendFinalMessage({ ...protocolEnvelope(), type: "handler-error", taskId: message.taskId, error: ipcError }, 1);
        return;
      }

      let ipcResult: Result;
      try {
        ipcResult = cloneIpcValue(result);
      } catch {
        await sendFinalMessage({ ...protocolEnvelope(), type: "serialization-error", taskId: message.taskId, direction: "result" }, 1);
        return;
      }
      await sendFinalMessage({ ...protocolEnvelope(), type: "result", taskId: message.taskId, result: ipcResult }, 0);
    })().catch(() => {
      disconnectAndExit(1);
    });
  };

  process.on("message", onMessage);
  void sendToParent({ ...protocolEnvelope(), type: "ready" }).catch(() => {
    disconnectAndExit(1);
  });
}

export type { ProcessHandler } from "./types";
