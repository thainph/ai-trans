// Messages between the Devdy tab (popup) and the background worker for settings/status.

import type { DevdyProject } from './core/client';

export const DEVDY_TARGET = 'context-kit-devdy';

export type DevdyRequest =
  | { target: typeof DEVDY_TARGET; type: 'status' }
  | { target: typeof DEVDY_TARGET; type: 'save-token'; token: string }
  /** Pin one of several running Devdy apps (port), or null for automatic. */
  | { target: typeof DEVDY_TARGET; type: 'select-instance'; port: number | null }
  | { target: typeof DEVDY_TARGET; type: 'flush' };

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
