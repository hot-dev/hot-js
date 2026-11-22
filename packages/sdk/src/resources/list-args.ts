import type { ListQuery } from "../types.js";

export interface SignalOptions {
  signal?: AbortSignal;
}

/**
 * Resolve `(query?, options?)` while remaining backwards-compatible with
 * 1.3.0 callers that passed `{ signal }` directly as the optional options bag.
 */
export function splitListArgs(
  queryOrOptions?: ListQuery | SignalOptions,
  options?: SignalOptions,
): { query?: ListQuery; signal?: AbortSignal } {
  if (
    options === undefined
    && queryOrOptions !== undefined
    && "signal" in queryOrOptions
  ) {
    return { signal: queryOrOptions.signal };
  }
  return {
    query: queryOrOptions as ListQuery | undefined,
    signal: options?.signal,
  };
}
