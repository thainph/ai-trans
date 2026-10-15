// Ids of cancellable translator requests (scoped to the sending frame by the SW).

/** A short random id; crypto.randomUUID() needs a secure context (missing on http:// pages). */
export function randomRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint32Array(3)), (n) => n.toString(36)).join('');
}
