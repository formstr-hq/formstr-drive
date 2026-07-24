export function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === "AbortError") ||
    (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ABORTED")
  );
}
