// CSS of the Shadow DOM widgets the content script injects into pages.

import { DEFAULT_SETTINGS } from '../shared/settings';

/** Selection popup (translation / grammar result). */
export const POPUP_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }

  .popup {
    width: var(--popup-width, ${DEFAULT_SETTINGS.popupWidth}px);
    height: var(--popup-height, auto);
    max-height: var(--popup-max-height, 70vh);
    display: flex;
    flex-direction: column;
    position: relative;
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    color: #1a1a1a;
    overflow: hidden;
  }

  .resize-handle {
    position: absolute;
    z-index: 10;
  }

  .resize-right, .resize-left {
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
  }

  .resize-right {
    right: -3px;
  }

  .resize-left {
    left: -3px;
  }

  .resize-top, .resize-bottom {
    left: 6px;
    right: 6px;
    height: 6px;
    cursor: row-resize;
  }

  .resize-top {
    top: -3px;
  }

  .resize-bottom {
    bottom: -3px;
  }

  .resize-handle:hover {
    background: rgba(37, 99, 235, 0.15);
    border-radius: 3px;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: #f8fafc;
    border-bottom: 1px solid #e5e7eb;
    flex-shrink: 0;
    cursor: grab;
    user-select: none;
  }

  .header:active {
    cursor: grabbing;
  }

  .lang-pair {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .lang-badge {
    padding: 3px 10px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 600;
    border: none;
    cursor: default;
  }

  .lang-badge.source {
    background: #dbeafe;
    color: #1e40af;
  }

  .arrow {
    color: #9ca3af;
    font-size: 14px;
  }

  .grammar-label {
    font-size: 12px;
    font-weight: 600;
    color: #15803d;
  }

  .lang-select {
    padding: 3px 6px;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 600;
    background: #dcfce7;
    color: #166534;
    cursor: pointer;
    outline: none;
  }

  .lang-select:focus {
    border-color: #2563eb;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 16px;
    color: #9ca3af;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
  }

  .close-btn:hover {
    background: #f3f4f6;
    color: #374151;
  }

  .result {
    padding: 14px;
    min-height: 50px;
    flex: 1 1 auto;
    overflow-y: auto;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .loading {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #6b7280;
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid #e5e7eb;
    border-top-color: #2563eb;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error {
    color: #dc2626;
    font-size: 13px;
  }

  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    border-top: 1px solid #e5e7eb;
    background: #f8fafc;
    flex-shrink: 0;
  }

  .copy-btn {
    padding: 5px 14px;
    background: #2563eb;
    color: white;
    border: none;
    border-radius: 5px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .copy-btn:hover:not(:disabled) {
    background: #1d4ed8;
  }

  .copy-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .replace-btn {
    padding: 5px 14px;
    background: #16a34a;
    color: white;
    border: none;
    border-radius: 5px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .replace-btn:hover:not(:disabled) {
    background: #15803d;
  }

  .replace-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .style-select {
    padding: 5px 8px;
    border: 1px solid #d1d5db;
    border-radius: 5px;
    font-size: 12px;
    background: white;
    color: #374151;
    cursor: pointer;
    outline: none;
  }

  .style-select:focus {
    border-color: #2563eb;
  }
`;

/** Full-page translation progress pill. */
export const LOADING_CSS = `
  .loading-bar {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: #1e293b;
    color: #e2e8f0;
    border-radius: 20px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    font-weight: 500;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.08);
    animation: fade-in 0.2s ease-out;
  }
  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255,255,255,0.2);
    border-top-color: #60a5fa;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
`;

/** Selection toolbar (T / G / R / ➤), inside the trigger host's Shadow DOM. */
export const TRIGGER_CSS = `
  :host {
    all: initial;
  }
  .ai-translator-trigger-container {
    display: flex;
    background: #1e293b;
    border-radius: 10px;
    box-shadow:
      0 4px 16px rgba(0, 0, 0, 0.25),
      0 0 0 1px rgba(255, 255, 255, 0.08);
    overflow: hidden;
    animation: ai-trigger-pop 0.15s ease-out;
  }

  @keyframes ai-trigger-pop {
    from {
      opacity: 0;
      transform: scale(0.8) translateY(4px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .ai-translator-trigger-container.single {
    border-radius: 50%;
  }

  .ai-translator-trigger {
    width: 34px;
    height: 34px;
    border: none;
    background: transparent;
    color: #e2e8f0;
    font-size: 13px;
    font-weight: 700;
    font-family: system-ui, -apple-system, sans-serif;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition:
      background 0.15s,
      color 0.15s;
    line-height: 1;
    padding: 0;
    position: relative;
  }

  .ai-translator-trigger:hover {
    background: rgba(255, 255, 255, 0.12);
    color: #ffffff;
  }

  .ai-translator-trigger:active {
    background: rgba(255, 255, 255, 0.2);
  }

  /* Blue accent for Translate */
  .ai-translator-trigger-translate:hover {
    background: rgba(59, 130, 246, 0.35);
    color: #93c5fd;
  }

  /* Purple accent for Reverse */
  .ai-translator-trigger-reverse:hover {
    background: rgba(139, 92, 246, 0.35);
    color: #c4b5fd;
  }

  /* Green accent for Grammar */
  .ai-translator-trigger-grammar:hover {
    background: rgba(34, 197, 94, 0.35);
    color: #86efac;
  }

  /* Teal accent for Send to Devdy */
  .ai-translator-trigger-devdy:hover {
    background: rgba(20, 184, 166, 0.35);
    color: #5eead4;
  }

  .ai-translator-trigger-devdy svg {
    display: block;
    pointer-events: none;
  }

  /* Divider between buttons */
  .ai-translator-trigger + .ai-translator-trigger::before {
    content: "";
    position: absolute;
    left: 0;
    top: 6px;
    bottom: 6px;
    width: 1px;
    background: rgba(255, 255, 255, 0.15);
  }
`;
