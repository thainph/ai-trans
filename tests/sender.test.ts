import { describe, expect, it } from 'vitest';
import { isContentScriptFrom, isExtensionPage, isExtensionSender } from '../src/shared/sender';

const ID = 'abc';
const BASE = 'chrome-extension://abc/';

describe('sender kinds', () => {
  it('extension sender: any context of this extension', () => {
    expect(isExtensionSender({ id: ID, url: 'https://example.com/' }, ID)).toBe(true);
    expect(isExtensionSender({ id: 'other', url: `${BASE}x.html` }, ID)).toBe(false);
  });

  it('extension page: our pages / service worker only, never content scripts', () => {
    expect(isExtensionPage({ id: ID, url: `${BASE}src/features/devdy/popup/popup.html` }, ID)).toBe(true);
    expect(isExtensionPage({ id: ID, url: `${BASE}background.js` }, ID)).toBe(true);
    expect(isExtensionPage({ id: ID, url: 'https://evil.example/', tab: {} }, ID)).toBe(false);
    expect(isExtensionPage({ id: 'other', url: `${BASE}x.html` }, ID)).toBe(false);
    expect(isExtensionPage({ id: ID }, ID)).toBe(false);
    expect(isExtensionPage({ id: ID, url: 'chrome-extension://abcdef/x.html' }, ID)).toBe(false);
  });

  it('content script from an exact origin', () => {
    const slack = 'https://app.slack.com';
    expect(isContentScriptFrom({ id: ID, url: 'https://app.slack.com/client/T1/C1' }, ID, slack)).toBe(true);
    expect(isContentScriptFrom({ id: ID, url: 'https://app.slack.com.evil.example/' }, ID, slack)).toBe(false);
    expect(isContentScriptFrom({ id: ID, url: 'https://example.com/' }, ID, slack)).toBe(false);
    expect(isContentScriptFrom({ id: 'other', url: 'https://app.slack.com/' }, ID, slack)).toBe(false);
    expect(isContentScriptFrom({ id: ID }, ID, slack)).toBe(false);
  });
});
