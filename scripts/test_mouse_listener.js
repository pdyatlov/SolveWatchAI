// Standalone smoke test for src/utils/mouse-listener.js (Phase 2).
// Usage: node scripts/test_mouse_listener.js
// Prints (x, y) for each left-click for 30 seconds, then exits.

import { onLeftDown } from '../src/utils/mouse-listener.js';

let count = 0;
const unsubscribe = onLeftDown((x, y) => {
  count++;
  console.log(`[click ${count}] x=${x} y=${y}`);
});

console.log('Listening for left-clicks for 30 seconds. Click anywhere on screen.');

setTimeout(() => {
  unsubscribe();
  console.log(`Done. Captured ${count} click(s).`);
  process.exit(0);
}, 30_000);
