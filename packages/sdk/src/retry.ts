const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

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
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** An AbortSignal that fires when any of `signals` does. */
export function mergeAbortSignals(signals: Array<AbortSignal | null | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** Error used when an SDK-enforced deadline passes. */
export function timeoutError(message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "TimeoutError";
  return error;
}
