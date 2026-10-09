// The one YAML front matter emitter (Slack threads, Web → MD pages, Devdy captures).

// YAML 1.1 + 1.2 words that would be parsed as booleans/null if left unquoted.
const YAML_RESERVED = /^(true|false|yes|no|y|n|on|off|null|~)$/i;

/**
 * Emit a string as a YAML scalar that is safe both as a block value and as a
 * flow-sequence item. Plain only when it starts with a letter and contains
 * letters, digits, spaces and ". _ ( ) / -"; otherwise a JSON string, which is
 * a valid YAML double-quoted scalar (handles quotes, colons, brackets, #, etc.).
 */
export function yamlScalar(value: string): string {
  const plainSafe = /^\p{L}[\p{L}\p{N} ._()/-]*$/u.test(value) && !/\s$/.test(value);
  if (plainSafe && !YAML_RESERVED.test(value)) return value;
  return JSON.stringify(value);
}

/** A value emitted as-is (already valid YAML, e.g. a timestamp). */
export interface YamlRaw {
  raw: string;
}

export const yamlRaw = (raw: string): YamlRaw => ({ raw });
/** A string emitted plain when that is safe (see yamlScalar), quoted otherwise. */
export const yamlPlain = (value: string): YamlRaw => ({ raw: yamlScalar(value) });

/** Strings are always double-quoted; arrays become flow sequences; undefined/null/'' fields are omitted. */
export type YamlValue = string | number | boolean | YamlRaw | string[] | null | undefined;

function emit(value: Exclude<YamlValue, null | undefined>): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(yamlScalar).join(', ')}]`;
  return value.raw;
}

/** `---\nkey: value\n…\n---` (no trailing newline), in field order. */
export function frontMatter(fields: Record<string, YamlValue>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`${key}: ${emit(value)}`);
  }
  lines.push('---');
  return lines.join('\n');
}
