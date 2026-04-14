// src/utils/mouse-listener.js
// Singleton wrapper around `uiohook-napi` that exposes a tiny subscribe API.
// Lifecycle is lazy + sticky: the OS hook starts on the first subscriber and
// stays running until the process exits. Subscribers come and go via the
// returned unsubscribe function; the underlying hook is never stopped.

import { uIOhook } from 'uiohook-napi';

const handlers = new Set();
let started = false;

function dispatcher(e) {
  // uIOhook button codes: 1 = left, 2 = right, 3 = middle.
  if (e.button !== 1) return;
  for (const h of handlers) {
    try {
      h(e.x, e.y);
    } catch {
      // One bad handler must not break the others. Errors are caller-side
      // bugs; the screenshot service already wraps its handler in try/catch.
    }
  }
}

/**
 * Subscribe to global left-mouse-button-down events.
 *
 * @param {(x: number, y: number) => void} handler - Called with raw OS pixel
 *   coordinates whenever the left mouse button is pressed anywhere on screen.
 * @returns {() => void} Unsubscribe function. Idempotent.
 */
export function onLeftDown(handler) {
  handlers.add(handler);
  if (!started) {
    uIOhook.on('mousedown', dispatcher);
    uIOhook.start();
    started = true;
  }
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    handlers.delete(handler);
  };
}
