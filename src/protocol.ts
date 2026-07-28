import { deserialize, serialize } from "node:v8";

import type { ProcessSerializationDirection, SerializedProcessError } from "./types";

export const PROTOCOL_NAME = "cerne-isolate";
export const PROTOCOL_VERSION = 1;

interface ProtocolEnvelope {
  protocol: typeof PROTOCOL_NAME;
  version: typeof PROTOCOL_VERSION;
}

export interface RunMessage<Payload> extends ProtocolEnvelope {
  type: "run";
  taskId: number;
  payload: Payload;
}

export interface ReadyMessage extends ProtocolEnvelope {
  type: "ready";
}

export interface ResultMessage<Result> extends ProtocolEnvelope {
  type: "result";
  taskId: number;
  result: Result;
}

export interface HandlerErrorMessage extends ProtocolEnvelope {
  type: "handler-error";
  taskId: number;
  error: SerializedProcessError;
}

export interface SerializationErrorMessage extends ProtocolEnvelope {
  type: "serialization-error";
  taskId: number;
  direction: Exclude<ProcessSerializationDirection, "request">;
}

export interface ProtocolErrorMessage extends ProtocolEnvelope {
  type: "protocol-error";
}

export type ChildMessage<Result> = ReadyMessage | ResultMessage<Result> | HandlerErrorMessage | SerializationErrorMessage | ProtocolErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTaskId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isSerializedProcessError(value: unknown, depth = 0, seen = new Set<object>()): value is SerializedProcessError {
  if (!isRecord(value) || depth > 4 || seen.has(value) || typeof value.name !== "string" || typeof value.message !== "string") {
    return false;
  }
  seen.add(value);
  if (value.stack !== undefined && typeof value.stack !== "string") {
    return false;
  }
  if (value.code !== undefined && typeof value.code !== "string" && typeof value.code !== "number") {
    return false;
  }
  return value.cause === undefined || isSerializedProcessError(value.cause, depth + 1, seen);
}

function hasProtocolEnvelope(value: Record<string, unknown>): boolean {
  return value.protocol === PROTOCOL_NAME && value.version === PROTOCOL_VERSION;
}

export function parseRunMessage(value: unknown): RunMessage<unknown> | null {
  if (!isRecord(value) || !hasProtocolEnvelope(value) || value.type !== "run" || !isTaskId(value.taskId) || !("payload" in value)) {
    return null;
  }
  return value as unknown as RunMessage<unknown>;
}

export function parseChildMessage(value: unknown): ChildMessage<unknown> | null {
  if (!isRecord(value) || !hasProtocolEnvelope(value) || typeof value.type !== "string") {
    return null;
  }
  if (value.type === "ready" || value.type === "protocol-error") {
    return value as unknown as ReadyMessage | ProtocolErrorMessage;
  }
  if (!isTaskId(value.taskId)) {
    return null;
  }
  if (value.type === "result" && "result" in value) {
    return value as unknown as ResultMessage<unknown>;
  }
  if (value.type === "handler-error" && isSerializedProcessError(value.error)) {
    return value as unknown as HandlerErrorMessage;
  }
  if (value.type === "serialization-error" && (value.direction === "result" || value.direction === "error")) {
    return value as unknown as SerializationErrorMessage;
  }
  return null;
}

export function cloneIpcValue<Value>(value: Value): Value {
  return deserialize(serialize(value)) as Value;
}

function safeProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}...`;
}

export function serializeProcessError(value: unknown, depth = 0, seen = new Set<object>()): SerializedProcessError {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    const objectValue = value as object;
    if (seen.has(objectValue)) {
      return { name: "Error", message: "Remote error cause is circular." };
    }
    seen.add(objectValue);

    const rawName = safeProperty(objectValue, "name");
    const rawMessage = safeProperty(objectValue, "message");
    const rawStack = safeProperty(objectValue, "stack");
    const rawCode = safeProperty(objectValue, "code");
    const rawCause = safeProperty(objectValue, "cause");
    const error: SerializedProcessError = {
      name: typeof rawName === "string" && rawName !== "" ? truncate(rawName, 256) : "Error",
      message: typeof rawMessage === "string" && rawMessage !== "" ? truncate(rawMessage, 65_536) : "Worker handler threw an error.",
    };
    if (typeof rawStack === "string") {
      error.stack = truncate(rawStack, 262_144);
    }
    if (typeof rawCode === "string" || typeof rawCode === "number") {
      error.code = typeof rawCode === "string" ? truncate(rawCode, 1024) : rawCode;
    }
    if (rawCause !== undefined && depth < 3) {
      error.cause = serializeProcessError(rawCause, depth + 1, seen);
    }
    return error;
  }

  const message = typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" ? String(value) : "Worker handler threw a non-Error value.";
  return { name: "NonErrorThrown", message: truncate(message, 65_536) };
}

export function protocolEnvelope(): ProtocolEnvelope {
  return { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION };
}
