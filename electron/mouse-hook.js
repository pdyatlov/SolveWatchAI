// electron/mouse-hook.js -- Phase 9 / HOTK-08
//
// Dual-dispatcher companion to electron/main.js's globalShortcut keyboard block.
// Observes mouse + wheel events via uiohook-napi and dispatches to the Phase 3
// handlerForSlot action map (injected via init()). Keyboard events from uIOhook
// are NEVER wired -- globalShortcut keeps owning keyboard slots (CONTEXT D-01).
//
// Singleton per process (spike C3). Import once from electron/main.js.
//
// Exports: init, shutdown, rebuildLookup, pause, resume
//
// References:
//   .planning/phases/09-mouse-button-hotkeys/09-CONTEXT.md (D-01..D-13)
//   .claude/skills/spike-findings-solvewatch-ai/references/uiohook-napi-integration.md

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// -- Module state --------------------------------------------------------
// Lazy-loaded so darwin (unsupported platform per D-13) never pays the native-
// module load cost. On Windows, resolved once at init() and cached.
let uIOhook = null;
let handlerForSlotRef = null;     // injected at init() time
let activeMouseBindings = {};     // { 'CommandOrControl+Mouse4': 'prev_question', ... }
let started = false;

// -- Event -> accelerator-token helpers (spike section 3 verbatim) -------
// Keep these pure so the dispatch code reads as a straight pipeline:
//   uIOhook ev -> fullAccelerator(ev) -> activeMouseBindings lookup -> handler().

// Two pure converters -- one per event kind. The dispatcher routes on listener
// NAME (uIOhook.on('mousedown', ...) vs uIOhook.on('wheel', ...)), so there is
// no need to re-dispatch on ev.type here. Empirically (Phase 9 UAT 2026-04-18)
// uiohook-napi 1.5.4 does NOT deliver ev.type === 'mousedown' / 'wheel' or the
// numeric constants 4 / 7 the initial implementation guessed from spike notes;
// its value differs by kernel + build. Trusting the listener dispatch is safer.
function mouseButtonToToken(ev) {
  switch (ev && ev.button) {
    case 3: return 'Mouse3';   // middle
    case 4: return 'Mouse4';   // XButton1 / back / thumb-down
    case 5: return 'Mouse5';   // XButton2 / forward / thumb-up
    // button 1 (left) and button 2 (right) intentionally unmapped per CONTEXT D-08.
    default: return null;
  }
}

function wheelRotationToToken(ev) {
  const r = ev && ev.rotation;
  if (typeof r !== 'number' || r === 0) return null;
  // rotation < 0 = physical UP (away from user); rotation > 0 = physical DOWN.
  return r < 0 ? 'WheelUp' : 'WheelDown';
}

function modifierPrefix(ev) {
  // uIOhook tracks modifier state on its own (CONTEXT D-02). Read from ev directly.
  const mods = [];
  if (ev.ctrlKey  || ev.metaKey) mods.push('CommandOrControl');
  if (ev.shiftKey)               mods.push('Shift');
  if (ev.altKey)                 mods.push('Alt');
  return mods;
}

function buildAccelerator(ev, tokenFn) {
  const tok = tokenFn(ev);
  if (!tok) return null;
  const mods = modifierPrefix(ev);
  return [...mods, tok].join('+');
}

// -- Event handlers ------------------------------------------------------
// Wired once in init(); stay attached across pause/resume (spike section 2).

// Trace toggle: set MOUSEHOOK_TRACE=1 in the environment (e.g. via start.ps1 or
// a developer shell) to re-enable the raw event dump that was used to diagnose
// the uiohook-napi ev.type mismatch during Phase 9 UAT (2026-04-18). Off by
// default so production logs stay quiet.
const TRACE_EVENTS = process.env.MOUSEHOOK_TRACE === '1';

function handleMouseDown(ev) {
  const accel = buildAccelerator(ev, mouseButtonToToken);
  if (TRACE_EVENTS) {
    console.log('[mouse-hook] trace mousedown:',
      'button=',   ev && ev.button,
      'ctrl=',     ev && (ev.ctrlKey || ev.metaKey),
      'shift=',    ev && ev.shiftKey,
      'alt=',      ev && ev.altKey,
      '-> accel=', accel);
  }
  if (!accel) return;  // Mouse1/Mouse2 or unrecognised button -> ignore
  const slot = activeMouseBindings[accel];
  if (!slot) {
    if (TRACE_EVENTS) console.log('[mouse-hook] unbound mouse accel:', accel, '(known bindings:', Object.keys(activeMouseBindings).join(',') || '<none>', ')');
    return;
  }
  const handler = handlerForSlotRef ? handlerForSlotRef(slot) : null;
  if (typeof handler !== 'function') return;
  try {
    handler();
    console.log('[mouse-hook] fired:', accel, '->', slot);
  } catch (err) {
    console.warn('[mouse-hook] handler threw for', accel, '->', slot, ':', err && err.message);
  }
}

function handleWheel(ev) {
  const accel = buildAccelerator(ev, wheelRotationToToken);
  if (TRACE_EVENTS) {
    console.log('[mouse-hook] trace wheel:',
      'rotation=', ev && ev.rotation,
      'ctrl=',     ev && (ev.ctrlKey || ev.metaKey),
      'shift=',    ev && ev.shiftKey,
      'alt=',      ev && ev.altKey,
      '-> accel=', accel);
  }
  if (!accel) return;
  const slot = activeMouseBindings[accel];
  if (!slot) {
    if (TRACE_EVENTS) console.log('[mouse-hook] unbound wheel accel:', accel, '(known bindings:', Object.keys(activeMouseBindings).join(',') || '<none>', ')');
    return;
  }
  const handler = handlerForSlotRef ? handlerForSlotRef(slot) : null;
  if (typeof handler !== 'function') return;
  try {
    handler();
    console.log('[mouse-hook] fired:', accel, '->', slot);
  } catch (err) {
    console.warn('[mouse-hook] handler threw for', accel, '->', slot, ':', err && err.message);
  }
}

// -- init ----------------------------------------------------------------
// Wire uIOhook listeners once. Handlers persist across pause/resume (spike section 2).
// { handlerForSlot } is the Phase 3 switch from electron/main.js -- passed in
// so the single source of truth for slot-to-action mapping stays in main.js.
export function init({ handlerForSlot } = {}) {
  if (process.platform === 'darwin') {
    console.log('[mouse-hook] init skipped: darwin platform (mouse bindings are Windows-only in v1)');
    return;
  }
  if (typeof handlerForSlot !== 'function') {
    console.warn('[mouse-hook] init called without handlerForSlot function; aborting');
    return;
  }
  handlerForSlotRef = handlerForSlot;

  try {
    // uiohook-napi is CJS-native; createRequire bridges ESM host to CJS module.
    const mod = require('uiohook-napi');
    uIOhook = mod.uIOhook;
  } catch (err) {
    console.warn('[mouse-hook] FAIL: uiohook-napi load error:', err && err.message ? err.message : String(err));
    console.warn('[mouse-hook] keyboard hotkeys unaffected; mouse bindings disabled until resolved');
    return;
  }

  try {
    uIOhook.on('mousedown', handleMouseDown);
    uIOhook.on('wheel',     handleWheel);
    uIOhook.start();
    started = true;
    console.log('[mouse-hook] initialized -> listening for mousedown + wheel');
  } catch (err) {
    console.warn('[mouse-hook] FAIL: uIOhook.start() threw:', err && err.message ? err.message : String(err));
  }
}

// -- rebuildLookup -------------------------------------------------------
// Walk a full seven-slot map and populate activeMouseBindings with only those
// whose accelerator ends in a Mouse*/Wheel* token. Called from electron/main.js's
// hotkeys-updated IPC handler (Plan 09-05 Task 3). O(slots) -- cheap.
const MOUSE_TOKENS = new Set(['Mouse3','Mouse4','Mouse5','WheelUp','WheelDown']);
const MANAGED_SLOTS = [
  'hud_toggle','listen_toggle','screenshot',
  'prev_question','next_question',
  'scroll_answer_up','scroll_answer_down',
];

export function rebuildLookup(map) {
  if (process.platform === 'darwin') return;
  const next = {};
  if (map && typeof map === 'object') {
    for (const slot of MANAGED_SLOTS) {
      const accel = map[slot];
      if (typeof accel !== 'string' || accel.length === 0) continue;
      const parts = accel.split('+');
      const last = parts[parts.length - 1];
      if (!MOUSE_TOKENS.has(last)) continue;  // keyboard slot, skip
      // Duplicate-accel guard: backend _findHotkeyConflicts should have caught
      // this, but if a hand-edited file slips through, first-bind-wins so we
      // don't lose the loop invariant.
      if (!(accel in next)) next[accel] = slot;
    }
  }
  activeMouseBindings = next;
  const boundCount = Object.keys(activeMouseBindings).length;
  console.log('[mouse-hook] rebuildLookup ok -> active bindings:', boundCount);
}

// -- pause / resume (capture-pause for Settings record mode) -------------
// uIOhook.stop() is a hard cut (spike 003: zero event leakage across 6s window).
// Handlers stay attached across stop/start -- no .off()/.on() bookkeeping.
// Called from electron/main.js's hotkeys-capture-pause IPC handler (Plan 09-05 Task 3).

export function pause() {
  if (process.platform === 'darwin') return;
  if (!uIOhook) return;
  if (!started)  return;
  try {
    uIOhook.stop();
    started = false;
    console.log('[mouse-hook] paused');
  } catch (err) {
    console.warn('[mouse-hook] pause error:', err && err.message);
  }
}

export function resume() {
  if (process.platform === 'darwin') return;
  if (!uIOhook) return;
  if (started)   return;
  try {
    uIOhook.start();
    started = true;
    console.log('[mouse-hook] resumed');
  } catch (err) {
    console.warn('[mouse-hook] resume error:', err && err.message);
  }
}

// -- shutdown ------------------------------------------------------------
// Idempotent. Called from app.on('will-quit') in electron/main.js.
export function shutdown() {
  if (!uIOhook) return;
  try {
    uIOhook.stop();
    started = false;
    activeMouseBindings = {};
    console.log('[mouse-hook] shutdown ok');
  } catch (err) {
    console.warn('[mouse-hook] shutdown error:', err && err.message);
  }
}
