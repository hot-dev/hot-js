const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

/** Maximum delay safe for 32-bit `setTimeout` timers (~24.8 days). */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Clamp a positive millisecond delay so `setTimeout` never overflows 32-bit
 * signed integer bounds (which Node.js silently coerces to 1 ms).
 */
export function clampTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, MAX_TIMEOUT_MS);
}

/**
 * Normalize a configured timeout in milliseconds: `undefined`, `<= 0`, or
 * non-finite values disable the timeout (`undefined`), and larger values are
 * clamped to `MAX_TIMEOUT_MS`.
 */
export function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Math.min(timeoutMs, MAX_TIMEOUT_MS);
}

/**
 * Jittered exponential backoff before consecutive failure `failures` (1-based):
 * half of `min(10 s, 500 ms * 2^(failures - 1))` plus a random share of the
 * other half. A server `retry_after` (seconds) is a floor.
 */
export function backoffDelayMs(failures: number, retryAfterSeconds?: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, failures - 1));
  const delay = ceiling / 2 + Math.random() * (ceiling / 2);
  return Math.max(delay, (retryAfterSeconds ?? 0) * 1000);
}

export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, clampTimeoutMs(ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** An AbortSignal that fires when any of `signals` does, without leaking listeners. */
export function mergeAbortSignals(signals: Array<AbortSignal | null | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => signal != null);
  if (active.length === 0) return new AbortController().signal;
  if (active.length === 1) return active[0]!;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(active);
  }
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  const cleanup = () => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  };
  for (const signal of active) {
    if (signal.aborted) {
      cleanup();
      controller.abort(signal.reason);
      return controller.signal;
    }
    const onAbort = () => {
      cleanup();
      controller.abort(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", onAbort));
  }
  return controller.signal;
}

/** Error used when an SDK-enforced deadline passes. */
export function timeoutError(message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "TimeoutError";
  return error;
}
