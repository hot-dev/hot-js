/**
 * Encode a single URL path segment, rejecting empty strings and dot-traversal
 * segments (`""`, `"."`, `".."`) before any network request is made.
 */
export function enc(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new RangeError(`Invalid path segment: ${JSON.stringify(value)}`);
  }
  return encodeURIComponent(value);
}

/**
 * Encode a slash-delimited relative path (stripping at most one leading `/`),
 * rejecting empty paths and any `""`, `"."`, or `".."` segment.
 */
export function encPath(path: string): string {
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  if (trimmed === "") {
    throw new RangeError(`Invalid path: ${JSON.stringify(path)}`);
  }
  return trimmed.split("/").map(enc).join("/");
}

/** Strip trailing `/` characters in linear time (avoids polynomial regex backtracking). */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}
