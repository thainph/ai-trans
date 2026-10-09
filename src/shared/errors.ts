/** Human-readable message of anything thrown. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
