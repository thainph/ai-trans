// Devdy grammar check (`POST /v1/grammar`, contract: devdy docs/inbox-api.md §6.5).
//
//   body {"text","explainLang"} (≤ 64 KB; text ≤ 8000 chars after trim, non-empty)
//   200 {"corrected","issues":[{"original","suggestion","explanation"}],"explainLang"}
//   JSON only (no SSE). Errors are JSON {"error"} with a status code; 502
//   `invalid grammar result` when the engine's answer isn't usable.
//
// The text is corrected in its own language (never translated); only the
// explanations are written in `explainLang`. Runs on the same warm engine
// session as /v1/translate and shares its limits (8000 chars, 4 requests in
// flight counted together with translations, 90 s). Pure apart from the
// injectable `fetch` → unit-tested. Service-worker only (CORS / PNA).

import type { FetchFn } from './client';
import { DevdyTranslateError, JSON_TIMEOUT_MS, linkedController, postEngine } from './translate';

export interface GrammarInput {
  text: string;
  /** Language of the explanations (Devdy code or name); null → Devdy's default target. */
  explainLang: string | null;
}

export interface GrammarIssue {
  /** The faulty passage, exactly as in the input (may occur several times; no offsets). */
  original: string;
  suggestion: string;
  /** Short reason in `explainLang` (may be empty). */
  explanation: string;
}

export interface GrammarResult {
  /** The whole text with every fix applied: the authoritative result. */
  corrected: string;
  issues: GrammarIssue[];
  /** As resolved by Devdy (not normalized). */
  explainLang?: string;
}

export interface GrammarOptions {
  signal?: AbortSignal;
  fetchFn?: FetchFn;
}

function parseIssue(v: unknown): GrammarIssue | null {
  if (!v || typeof v !== 'object') return null;
  const { original, suggestion, explanation } = v as Record<string, unknown>;
  if (typeof original !== 'string' || typeof suggestion !== 'string') return null;
  // Devdy already drops these; keep the guarantee on our side too.
  if (!original || original === suggestion) return null;
  return { original, suggestion, explanation: typeof explanation === 'string' ? explanation : '' };
}

export function parseGrammarResult(j: unknown): GrammarResult | null {
  if (!j || typeof j !== 'object') return null;
  const { corrected, issues, explainLang } = j as Record<string, unknown>;
  if (typeof corrected !== 'string') return null;
  const result: GrammarResult = {
    corrected,
    issues: Array.isArray(issues) ? issues.map(parseIssue).filter((i): i is GrammarIssue => i !== null) : [],
  };
  if (typeof explainLang === 'string') result.explainLang = explainLang;
  return result;
}

/** Check `input.text` (≤ 8000 chars). Rejects with a DevdyTranslateError (task "grammar"). */
export async function checkGrammar(
  port: number,
  token: string,
  input: GrammarInput,
  { signal, fetchFn = fetch }: GrammarOptions = {},
): Promise<GrammarResult> {
  const ctrl = linkedController(signal);
  const timer = setTimeout(() => ctrl.abort(new DOMException('Timeout', 'TimeoutError')), JSON_TIMEOUT_MS);
  try {
    const res = await postEngine(port, token, {
      task: 'grammar',
      path: '/v1/grammar',
      body: { text: input.text, explainLang: input.explainLang },
      accept: 'application/json',
      signal: ctrl.signal,
      callerSignal: signal,
      fetchFn,
    });
    let j: unknown;
    try {
      j = await res.json();
    } catch {
      if (signal?.aborted) throw new DevdyTranslateError('cancelled', '', undefined, 'grammar');
      if (ctrl.signal.aborted) throw new DevdyTranslateError('timeout', '', undefined, 'grammar');
      throw new DevdyTranslateError('protocol', 'invalid JSON', undefined, 'grammar');
    }
    const result = parseGrammarResult(j);
    if (!result) throw new DevdyTranslateError('protocol', 'no corrected text in the response', undefined, 'grammar');
    return result;
  } finally {
    clearTimeout(timer);
  }
}
