// Streamed selection translation port (service worker side): one port per
// request, one `translate` message, events back until `done` / `error`.
// Disconnecting the port aborts the request; nothing is posted afterwards.
// chrome-free (the port and the work are passed in) → unit-tested.

import type { StreamTranslateEvent, StreamTranslateRequest } from '../shared/messages';
import { isStreamRequest, streamPortRejectReason } from './sender';

/** The chrome.runtime.Port members used here. */
export interface StreamPort {
  name: string;
  sender?: chrome.runtime.MessageSender;
  postMessage(message: StreamTranslateEvent): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface StreamPortDeps {
  extensionId: string;
  /** Translate, posting progress events; resolves with the full text. */
  translate(
    request: StreamTranslateRequest,
    signal: AbortSignal,
    post: (e: StreamTranslateEvent) => void,
  ): Promise<string>;
  /** The `error` event of a failure. */
  errorEvent(err: unknown): Extract<StreamTranslateEvent, { type: 'error' }>;
}

/** Serve one stream port (call from chrome.runtime.onConnect for every port). Returns false when it isn't ours. */
export function serveStreamPort(port: StreamPort, deps: StreamPortDeps): boolean {
  const refused = streamPortRejectReason(port, deps.extensionId);
  if (refused === 'Unknown port') return false;
  if (refused) {
    port.disconnect();
    return true;
  }
  const ctrl = new AbortController();
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
    ctrl.abort();
  });
  const post = (event: StreamTranslateEvent) => {
    if (!open || ctrl.signal.aborted) return;
    try {
      port.postMessage(event);
    } catch {
      open = false;
    }
  };
  let started = false;
  port.onMessage.addListener((msg) => {
    if (started) return; // one request per port
    started = true;
    if (!isStreamRequest(msg)) {
      post({ type: 'error', error: 'Invalid request' });
      return;
    }
    deps.translate(msg, ctrl.signal, post).then(
      (text) => post({ type: 'done', text }),
      (err: unknown) => post(deps.errorEvent(err)),
    );
  });
  return true;
}
