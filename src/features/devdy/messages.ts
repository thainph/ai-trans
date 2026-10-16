// Messages between the Devdy tab (popup) and the background worker for settings/status.

import type { Command } from '../../shared/messaging';

export const DEVDY_TARGET = 'context-kit-devdy';

export type DevdyRequest =
  | { target: typeof DEVDY_TARGET; type: 'status' }
  | { target: typeof DEVDY_TARGET; type: 'save-token'; token: string }
  /** Pin one of several running Devdy apps (port), or null for automatic. */
  | { target: typeof DEVDY_TARGET; type: 'select-instance'; port: number | null }
  | { target: typeof DEVDY_TARGET; type: 'flush' }
  /** Remove a queued Slack link. */
  | { target: typeof DEVDY_TARGET; type: 'remove'; id: string }
  /** Hide the queue notice (dropped links, migration…). */
  | { target: typeof DEVDY_TARGET; type: 'clear-notice' };

/** A Slack thread link waiting for Devdy. */
export interface PendingLink {
  id: string;
  url: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export interface DevdyStatus {
  /** The Devdy used for sends answered /health. */
  connected: boolean;
  port?: number;
  version?: string;
  /** Optional Devdy features (from /health) of the connected app. */
  features: { translate: boolean; slackThreadLink: boolean };
  /** Every Devdy app answering on 47821…47830. */
  instances: { port: number; version?: string }[];
  /** The user pinned `port`. */
  pinned: boolean;
  /** Several apps run and none is pinned → sends wait for a choice. */
  needsInstanceChoice?: boolean;
  hasToken: boolean;
  /** true/false once checked against /v1/projects; undefined when unknown. */
  tokenValid?: boolean;
  /** Links waiting in the queue, oldest first. */
  queue: PendingLink[];
  /** Automatic retries stopped (token missing/rejected) until a token is saved. */
  paused?: boolean;
  /** Last queue problem (links dropped after 7 days, old exports dropped on update…). */
  notice?: string;
  error?: string;
  /** Queued links delivered right after saving a token / picking an instance. */
  flushed?: number;
}

/** Response to `flush`. */
export interface DevdyFlushResult {
  sent: number;
  pending: number;
  status: DevdyStatus;
}

export type DevdyCommand = Command<DevdyRequest>;
