// Messages between the Slack popup and the background worker for Devdy settings/status.

import type { DevdyProject } from '../core/devdy-client';

export const DEVDY_TARGET = 'context-kit-devdy';

export type DevdyRequest =
  | { target: typeof DEVDY_TARGET; type: 'status' }
  | { target: typeof DEVDY_TARGET; type: 'save-token'; token: string }
  | { target: typeof DEVDY_TARGET; type: 'flush' };

export interface DevdyStatus {
  /** A Devdy inbox answered /health. */
  connected: boolean;
  port?: number;
  version?: string;
  hasToken: boolean;
  /** true/false once checked against /v1/projects; undefined when unknown. */
  tokenValid?: boolean;
  projects: DevdyProject[];
  /** Exports waiting in the outbox. */
  pending: number;
  error?: string;
  /** Queued exports delivered right after saving a token. */
  flushed?: number;
}

/** A request without its `target` (distributes over the union). */
export type DevdyCommand = DevdyRequest extends infer R ? (R extends DevdyRequest ? Omit<R, 'target'> : never) : never;
