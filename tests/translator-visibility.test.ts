// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { isElementVisible } from '../src/features/translator/core/visibility';

describe('isElementVisible', () => {
  it('is ancestor-aware (display: none / visibility: hidden subtrees)', () => {
    document.body.innerHTML = `
      <div id="shown"><span id="a">a</span></div>
      <div style="display:none"><p><span id="b">b</span></p></div>
      <div style="visibility:hidden"><span id="c">c</span></div>`;
    const el = (id: string) => document.getElementById(id)!;
    expect(isElementVisible(el('a'))).toBe(true);
    expect(isElementVisible(el('b'))).toBe(false);
    expect(isElementVisible(el('c'))).toBe(false);
  });

  it('uses checkVisibility({ checkVisibilityCSS }) when available', () => {
    const el = document.createElement('span');
    const calls: unknown[] = [];
    el.checkVisibility = (opts?: unknown) => {
      calls.push(opts);
      return false;
    };
    expect(isElementVisible(el)).toBe(false);
    expect(calls).toEqual([{ checkVisibilityCSS: true }]);
  });
});
