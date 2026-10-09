// Messages between the Devdy tab (popup) and the background worker for settings/status.

import type { DevdyProject, SendOutcome } from './core/client';

/** Result of one send through the outbox, as reported to the UI. */
export interface DevdyDelivery {
  kind: SendOutcome['kind'];
  message: string;
  /** Exports still queued for Devdy (incl. this one if it could not be sent). */
  pending: number;
}

export const DEVDY_TARGET = 'context-kit-devdy';

export type DevdyRequest =
  | { target: typeof DEVDY_TARGET; type: 'status' }
  | { target: typeof DEVDY_TARGET; type: 'save-token'; token: string }
  /** Pin one of several running Devdy apps (port), or null for automatic. */
  | { target: typeof DEVDY_TARGET; type: 'select-instance'; port: number | null }
  | { target: typeof DEVDY_TARGET; type: 'flush' }
  /** Delete a failed export (kept after Devdy refused it) and its payload. */
  | { target: typeof DEVDY_TARGET; type: 'remove-failed'; id: string }
  /** Hide the outbox notice (e.g. "dropped N exports"). */
  | { target: typeof DEVDY_TARGET; type: 'clear-notice' };

/** An export Devdy refused (too large, invalid…), kept so the user can download it. */
export interface FailedExport {
  id: string;
  title: string;
  contentType: string;
  size?: number;
  message: string;
  at: string;
}

export interface DevdyStatus {
  /** The Devdy used for sends answered /health. */
  connected: boolean;
  port?: number;
  version?: string;
  /** Every Devdy app answering on 47821…47830. */
  instances: { port: number; version?: string }[];
  /** The user pinned `port`. */
  pinned: boolean;
  /** Several apps run and none is pinned → sends wait for a choice. */
  needsInstanceChoice?: boolean;
  hasToken: boolean;
  /** true/false once checked against /v1/projects; undefined when unknown. */
  tokenValid?: boolean;
  projects: DevdyProject[];
  /** Exports waiting in the outbox. */
  pending: number;
  /** Exports Devdy refused; payload still stored (IndexedDB) for download. */
  failed: FailedExport[];
  /** Automatic retries stopped (token missing/rejected) until a token is saved. */
  paused?: boolean;
  /** Last outbox problem (e.g. exports dropped after 7 days / too many attempts). */
  notice?: string;
  error?: string;
  /** Queued exports delivered right after saving a token / picking an instance. */
  flushed?: number;
}

/** Response to `flush`. */
export interface DevdyFlushResult {
  sent: number;
  pending: number;
  status: DevdyStatus;
}

/** A request without its `target` (distributes over the union). */
export type DevdyCommand = DevdyRequest extends infer R ? (R extends DevdyRequest ? Omit<R, 'target'> : never) : never;
