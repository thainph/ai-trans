// Runtime messaging helpers shared by every feature.
//
// Each channel is identified by a `target` string on the message, so several
// independent chrome.runtime.onMessage listeners can coexist (service worker,
// offscreen document, content scripts).

import { errorMessage } from './errors';

/** Response shape of every request/response channel: `ok` + payload, or an error. */
// biome-ignore lint/complexity/noBannedTypes: `{}` = no payload
export type Result<T extends object = {}> = ({ ok: true } & T) | { ok: false; error: string };

export const ok = <T extends object>(value: T): Result<T> => ({ ok: true, ...value });
export const fail = (e: unknown): { ok: false; error: string } => ({ ok: false, error: errorMessage(e) });

/** A message on a targeted channel. */
export interface TargetedMessage<T extends string = string> {
  target: T;
}

/**
 * Listen to messages whose `target` matches. The handler's return value is the
 * response: `undefined` → no response, a promise → async response (a rejection
 * is answered with `{ ok: false, error }`), anything else → sent right away.
 */
export function onTargetMessage<M extends TargetedMessage>(
  target: M['target'],
  handler: (msg: M, sender: chrome.runtime.MessageSender) => unknown,
): void {
  chrome.runtime.onMessage.addListener((msg: M, sender, sendResponse) => {
    if (msg?.target !== target) return;
    const res = handler(msg, sender);
    if (res === undefined) return;
    if (res instanceof Promise) {
      res.then(sendResponse, (e: unknown) => sendResponse(fail(e)));
      return true; // async response
    }
    sendResponse(res);
  });
}
