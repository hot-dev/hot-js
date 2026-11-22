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
