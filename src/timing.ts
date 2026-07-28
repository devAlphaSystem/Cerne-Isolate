export type MonotonicTimestamp = bigint;

export function startTimer(): MonotonicTimestamp {
  return process.hrtime.bigint();
}

export function elapsedMilliseconds(startedAt: MonotonicTimestamp): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}
