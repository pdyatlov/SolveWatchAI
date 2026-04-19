import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn as cpSpawn, execFile } from 'child_process';
import http from 'http';
import { fileURLToPath } from 'url';

// Phase 9 / HOTK-08: dual-dispatcher mouse/wheel hook (singleton).
// Keyboard slots stay on globalShortcut; mouse/wheel slots go through this module.
import * as mouseHook from './mouse-hook.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOCKET_URL = process.env.SOCKET_URL || 'http://localhost:4000';

let overlayWindow = null;
let dragState = null;

// Tray surface (04-01). The tray object MUST stay referenced at module scope or
// V8 may GC it and the icon disappears mid-session (see 04-RESEARCH.md Pitfall 7).
let tray = null;
// Populated by Plan 04-03's readPidfile() — stays null in this plan, which means
// buildTrayMenu() renders the Restart item as .enabled=false per CONTEXT.md D-16.
let managedPids = null;

// ─── Pidfile read with freshness + liveness validation (04-03, D-13) ──
// start.ps1 writes logs/pids.json atomically after all services spawn.
// Electron reads ONCE at app.whenReady and populates managedPids. Restart
// spawns a fresh Electron process that reads a fresh pidfile.
//
// Validation prevents rogue PID kills on stale pidfiles (04-RESEARCH.md §Pitfall 6):
//   - timestamp older than 24h → stale, reject
//   - nodePid not alive (process.kill(pid, 0) throws) → start.ps1 crashed, reject
function readPidfile() {
  const p = path.join(process.cwd(), 'logs', 'pids.json');
  try {
    // Strip BOM defensively — Pitfall 8. start.ps1's Write-PidFile emits no BOM
    // but belt-and-suspenders in case the user manually edits the file.
    const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (typeof parsed.nodePid !== 'number' || typeof parsed.pyPid !== 'number') {
      console.warn('[tray] pidfile missing required nodePid/pyPid fields — standalone mode');
      return null;
    }
    // Freshness check: reject pidfiles older than 24h (PID reuse risk).
    const ageMs = Date.now() - new Date(parsed.timestamp).getTime();
    if (!Number.isFinite(ageMs) || ageMs > 24 * 3600 * 1000) {
      console.warn('[tray] pidfile stale (ageMs=', ageMs, ') — standalone mode');
      return null;
    }
    // Liveness probe on nodePid — if Node itself is gone, the pidfile is orphaned.
    // process.kill(pid, 0) throws ESRCH when pid is dead.
    try { process.kill(parsed.nodePid, 0); }
    catch { console.warn('[tray] nodePid', parsed.nodePid, 'not alive — standalone mode'); return null; }
    return parsed;
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn('[tray] pidfile read failed:', err.message);
    }
    return null;
  }
}

// ─── HUD window state persistence (POLISH-01, D-01..D-04) ────────────
// Writes bounds to config/hud-window.json on BrowserWindow 'moved'/'resized'
// completion events (debounced 500ms per D-02) and flushes eagerly on 'hide'
// and 'closed'. Read once on show; clamped to nearest display via
// screen.getDisplayMatching per D-03. First-ever launch (ENOENT) falls back
// to positionOverlayOnDisplayUnderCursor (D-04) and persists immediately.
//
// Using 'moved' + 'resized' (NOT 'move' + 'resize'): Electron Issue #18978
// — on Windows, 'move' and 'resize' fire per-pixel during drag (~60-120Hz)
// AND 'resize' also fires on horizontal move. Completion events fire once.
//
// Atomic write pattern (temp+rename) mirrors readPidfile / writeReadySentinel.
const HUD_WINDOW_JSON = path.join(process.cwd(), 'config', 'hud-window.json');
const HUD_BOUNDS_SAVE_DEBOUNCE_MS = 500;  // D-02 (Claude's Discretion band 300-800)
const HUD_DEFAULT_WIDTH = 380;            // matches existing BrowserWindow width
const HUD_DEFAULT_HEIGHT = 460;           // matches positionOverlayOnDisplayUnderCursor

let hudBoundsSaveTimer = null;

function loadSavedBounds() {
  try {
    const raw = fs.readFileSync(HUD_WINDOW_JSON, 'utf8').replace(/^\uFEFF/, '');
    const s = JSON.parse(raw);
    // V5 input validation (06-RESEARCH §Security Domain): reject non-numeric,
    // reject pathological rects. Fall through to ENOENT branch on any failure.
    if (!s || typeof s !== 'object') return null;
    for (const k of ['x', 'y', 'width', 'height']) {
      if (!Number.isFinite(s[k])) return null;
    }
    if (s.width < 100 || s.width > 10000) return null;
    if (s.height < 100 || s.height > 10000) return null;
    return { x: s.x, y: s.y, width: s.width, height: s.height };
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn('[hud-window] read failed:', err.message);
    }
    return null;
  }
}

function clampToWorkArea(bounds) {
  // D-03: use screen.getDisplayMatching — returns the display that MOST CLOSELY
  // intersects bounds, with built-in nearest-display fallback when bounds are
  // entirely off-screen. Preserves relative position across monitor changes.
  const display = screen.getDisplayMatching(bounds);
  const wa = display.workArea;
  const width  = Math.min(bounds.width,  wa.width);
  const height = Math.min(bounds.height, wa.height);
  const x = Math.max(wa.x, Math.min(wa.x + wa.width  - width,  bounds.x));
  const y = Math.max(wa.y, Math.min(wa.y + wa.height - height, bounds.y));
  return { x, y, width, height };
}

function flushSaveBounds() {
  if (hudBoundsSaveTimer) { clearTimeout(hudBoundsSaveTimer); hudBoundsSaveTimer = null; }
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const b = overlayWindow.getBounds();
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return;
  const out = { x: b.x, y: b.y, width: b.width, height: b.height };
  try {
    const configDir = path.dirname(HUD_WINDOW_JSON);
    fs.mkdirSync(configDir, { recursive: true });
    const tmp = HUD_WINDOW_JSON + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, HUD_WINDOW_JSON);  // atomic — V12 File/Resources mitigation
  } catch (err) {
    console.warn('[hud-window] save failed:', err.message);
  }
}

function scheduleSaveBounds() {
  if (hudBoundsSaveTimer) clearTimeout(hudBoundsSaveTimer);
  hudBoundsSaveTimer = setTimeout(flushSaveBounds, HUD_BOUNDS_SAVE_DEBOUNCE_MS);
}

// ─── Graceful kill with taskkill /F /T /PID fallback (04-03, D-14) ─────
// On Windows, Node's process.kill(pid, 'SIGTERM') is documented to behave
// like SIGKILL (immediate, no cleanup opportunity) — per Node docs. We still
// call SIGTERM first because it's the Node-layer abstraction; on non-Windows
// it would be graceful, on Windows it's immediate.
//
// Two-stage: SIGTERM → 600ms grace → liveness probe → taskkill /F /T /PID
// if still alive. /T kills the process tree (covers Python subprocess workers
// if any spawned — currently none, but defensive).
//
// Reference: 04-RESEARCH.md §Q5 (lines 363-418) + §"Don't Hand-Roll" row:
//   "tree-kill npm package: fine, but unnecessary. Inline execFile saves a dep."
function gracefulKill(pid, label, onDone) {
  if (!pid) { onDone && onDone(); return; }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    try {
      process.kill(pid, 0);  // liveness probe — throws if dead
      // Still alive — forceful tree-kill via taskkill
      execFile('taskkill', ['/F', '/T', '/PID', String(pid)], (err) => {
        if (err) console.warn(`[tray] taskkill ${label} pid=${pid}:`, err.message);
        onDone && onDone();
      });
    } catch {
      // Liveness probe threw — already dead, nothing to do
      onDone && onDone();
    }
  }, 600);
}

// Hotkey slot IDs — all seven slots are registered as globalShortcut so they fire
// regardless of which window has keyboard focus. Prev/Next and scroll deliberately
// became global after UAT: reading/navigating the HUD while watching the interviewer
// shouldn't require refocusing the overlay.
const GLOBAL_HOTKEY_SLOTS = [
  'hud_toggle', 'listen_toggle', 'screenshot',
  'prev_question', 'next_question',
  'scroll_answer_up', 'scroll_answer_down',
];

// Factory defaults — MUST stay in sync with src/controllers/config.controller.js DEFAULT_HOTKEYS.
const DEFAULT_HOTKEYS = {
  hud_toggle:         'CommandOrControl+Shift+H',
  listen_toggle:      'CommandOrControl+Shift+X',
  screenshot:         'CommandOrControl+Shift+P',
  prev_question:      'CommandOrControl+Left',
  next_question:      'CommandOrControl+Right',
  scroll_answer_up:   'CommandOrControl+Shift+Up',
  scroll_answer_down: 'CommandOrControl+Shift+Down',
};

// Current accelerator for each slot — updated by registerGlobalHotkeys on success,
// kept unchanged on per-slot OS rejection (D-12).
let activeGlobals = { ...DEFAULT_HOTKEYS };

function positionOverlayOnDisplayUnderCursor(win) {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { workArea } = display;

  const insetX = 24;
  const insetY = 24;
  const width = 380;
  const height = 460;

  const x = workArea.x + insetX;
  const y = workArea.y + insetY;

  win.setBounds({ x, y, width, height });
}

function createOverlayWindow() {
  if (overlayWindow) {
    overlayWindow.show();
    // POLISH-01 D-03: re-apply content protection (Pitfall 1) AND restore saved
    // bounds via clamp on this early-return show path. Falls back to the
    // first-launch seed if no saved bounds yet (mid-session config delete).
    overlayWindow.setContentProtection(true);
    const earlySaved = loadSavedBounds();
    if (earlySaved) {
      overlayWindow.setBounds(clampToWorkArea(earlySaved));
    } else {
      positionOverlayOnDisplayUnderCursor(overlayWindow);
      flushSaveBounds();
    }
    return;
  }

  // POLISH-01 D-04: read saved bounds BEFORE constructing the BrowserWindow so the
  // window opens at its persisted position+size in a single step (no setBounds flash).
  const savedBounds = loadSavedBounds();
  const clampedBounds = savedBounds ? clampToWorkArea(savedBounds) : null;

  overlayWindow = new BrowserWindow({
    parent: undefined,
    x: clampedBounds ? clampedBounds.x : undefined,
    y: clampedBounds ? clampedBounds.y : undefined,
    width:  clampedBounds ? clampedBounds.width  : HUD_DEFAULT_WIDTH,
    height: clampedBounds ? clampedBounds.height : 600,
    transparent: false,
    backgroundColor: '#12121a',
    frame: false,
    hasShadow: true,
    thickFrame: false,
    skipTaskbar: true,
    focusable: true,
    show: false,
    nodeIntegration: false,
    contextIsolation: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  overlayWindow.setContentProtection(true);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  overlayWindow.once('ready-to-show', () => {
    // POLISH-01 D-04 first-launch path: no config/hud-window.json yet → run the
    // cursor-display seed AND immediately persist so cursor-display inset never
    // runs again. When saved bounds exist, the BrowserWindow constructor already
    // applied them — no extra setBounds call needed here.
    if (!loadSavedBounds()) {
      positionOverlayOnDisplayUnderCursor(overlayWindow);
      flushSaveBounds();
    }

    // POLISH-02 D-06 + Pitfall 1 mitigation: re-apply content protection BEFORE
    // show(). Electron #45844 (PR #45868 merged to 34-x-y + 35-x-y only, NOT
    // 33-x-y): win.hide() clears WDA_EXCLUDEFROMCAPTURE on 33.x, and on cold
    // launch the window is created with `show: false` so it's effectively
    // hidden right before this first show(). Without the re-apply, Discord
    // can capture the HUD on its very first appearance.
    overlayWindow.setContentProtection(true);

    // POLISH-02 D-06: show BEFORE sentinel — ready-to-show guarantees first
    // paint completed. show() makes it visible; sentinel telling start.ps1 to
    // SW_HIDE the console fires only AFTER the window is visible.
    overlayWindow.show();

    // POLISH-02 D-06 + D-07: idempotent sentinel write — global helper set up
    // in app.whenReady; calls writeReadySentinel exactly once whether invoked
    // from here or from the 15s watchdog.
    if (global.__hudWriteOnceSentinel) global.__hudWriteOnceSentinel();
  });

  // POLISH-01 D-02: debounced save on BrowserWindow completion events.
  // 'moved' + 'resized' (NOT 'move' + 'resize') — see RESEARCH §Pitfall 2.
  overlayWindow.on('moved',   scheduleSaveBounds);
  overlayWindow.on('resized', scheduleSaveBounds);

  overlayWindow.on('closed', () => {
    flushSaveBounds();                                // D-02 eager flush BEFORE overlayWindow is nulled
    overlayWindow = null;
    dragState = null;
    // 04-01: rebuild so the menu reflects "HUD is gone" state.
    scheduleTrayRebuild();
  });

  // 04-01: rebuild tray menu so the Show HUD / Hide HUD label tracks visibility.
  // tray may be null if createOverlayWindow is called before app.whenReady
  // completes — guard handled inside scheduleTrayRebuild().
  overlayWindow.on('show',   () => { scheduleTrayRebuild(); });
  overlayWindow.on('hide',   () => {
    flushSaveBounds();                                // POLISH-01 D-02 eager flush
    scheduleTrayRebuild();
  });

  ipcMain.on('hud-drag-start', (_e, screenX, screenY) => {
    if (overlayWindow) {
      const [x, y] = overlayWindow.getPosition();
      dragState = {
        startScreenX: screenX,
        startScreenY: screenY,
        startX: x,
        startY: y,
      };
    }
  });

  ipcMain.on('hud-drag-move', (_e, screenX, screenY) => {
    if (dragState && overlayWindow) {
      const deltaX = screenX - dragState.startScreenX;
      const deltaY = screenY - dragState.startScreenY;
      overlayWindow.setPosition(
        Math.round(dragState.startX + deltaX),
        Math.round(dragState.startY + deltaY),
      );
    }
  });

  ipcMain.on('hud-drag-end', () => {
    dragState = null;
  });

  ipcMain.on('hud-set-opacity', (_e, value) => {
    if (!overlayWindow) return;
    // value: 0 = fully opaque, 100 = fully transparent
    // clamp to 0.1 minimum so the window stays visible/clickable
    const opacity = Math.max(0.1, 1 - Math.max(0, Math.min(100, value)) / 100);
    overlayWindow.setOpacity(opacity);
  });

  overlayWindow.loadFile(path.join(__dirname, 'hud.html'), {
    query: { socketUrl: SOCKET_URL },
  });
}

function toggleOverlay() {
  if (!overlayWindow) {
    createOverlayWindow();
    return;
  }

  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
  } else {
    overlayWindow.show();
    // Re-apply content protection: Electron #45844 — win.hide() clears
    // setContentProtection(true) on Windows in 33.x, and the fix is NOT
    // backported to 33.4.11 (our installed version). This re-apply is
    // idempotent and restores WDA_EXCLUDEFROMCAPTURE on every show.
    overlayWindow.setContentProtection(true);
    // POLISH-01 D-03: replace cursor-display reset with saved-bounds clamp.
    // On the rare case loadSavedBounds returns null (user deleted the file
    // mid-session), fall back to positionOverlayOnDisplayUnderCursor + seed.
    const saved = loadSavedBounds();
    if (saved) {
      overlayWindow.setBounds(clampToWorkArea(saved));
    } else {
      positionOverlayOnDisplayUnderCursor(overlayWindow);
      flushSaveBounds();
    }
  }
}

function readScreenshotsPath() {
  try {
    const configPath = path.join(process.cwd(), 'config', 'api-keys.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.screenshots_path === 'string' && parsed.screenshots_path.trim()) {
      return parsed.screenshots_path.trim();
    }
  } catch {
    // fall through to default
  }
  const fallback = path.join(app.getPath('userData'), 'screenshots');
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch {}
  console.warn(`[hotkey] screenshots_path not set in config/api-keys.json, using fallback: ${fallback}`);
  return fallback;
}

async function captureScreenUnderCursor() {
  try {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    });

    const source = sources.find((s) => Number(s.display_id) === display.id)
      || sources[0];

    if (!source || source.thumbnail.isEmpty()) {
      console.warn('[hotkey] no desktop source or empty thumbnail — screen recording permission may be missing (macOS)');
      return;
    }

    const pngBuffer = source.thumbnail.toPNG();

    const screenshotsPath = readScreenshotsPath();
    try {
      fs.mkdirSync(screenshotsPath, { recursive: true });
    } catch {}

    const filename = `hotkey-${Date.now()}.png`;
    const outPath = path.join(screenshotsPath, filename);
    await fs.promises.writeFile(outPath, pngBuffer);
    console.log(`[hotkey] wrote ${outPath}`);
  } catch (err) {
    console.error('[hotkey] capture failed:', err);
  }
}

// ── Hotkey re-registration helpers (Phase 3) ──────────────────────────

// Handlers for every global slot. Extracted so they can be re-bound to new accelerators.
// Navigate/scroll handlers send IPC to the HUD renderer, which owns the Q&A viewer DOM.
function handlerForSlot(slot) {
  switch (slot) {
    case 'hud_toggle':         return toggleOverlay;
    case 'listen_toggle':      return () => overlayWindow?.webContents.send('toggle-listen');
    case 'screenshot':         return captureScreenUnderCursor;
    case 'prev_question':      return () => overlayWindow?.webContents.send('navigate', -1);
    case 'next_question':      return () => overlayWindow?.webContents.send('navigate', 1);
    case 'scroll_answer_up':   return () => overlayWindow?.webContents.send('scroll-answer', -80);
    case 'scroll_answer_down': return () => overlayWindow?.webContents.send('scroll-answer', 80);
    default:                   return null;
  }
}

// Relay a register failure back to the renderer so the settings UI can show a per-row warning (D-12).
function relayRegisterFailure(slot, accel, reason) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('hotkey-register-failed', { slot, accel, reason });
  }
  console.warn(`[hotkey] register failed for ${slot}=${accel}: ${reason}`);
}

// Attempt to register a single global slot. Returns the accelerator that ended up active
// (new on success, previous on failure).
function registerSingleGlobal(slot, newAccel) {
  const handler = handlerForSlot(slot);
  if (!handler) {
    relayRegisterFailure(slot, newAccel, 'unknown slot');
    return activeGlobals[slot];
  }
  if (!newAccel) {
    // Empty string = slot intentionally disabled (Backspace in capture widget).
    return '';
  }
  let ok = false;
  try {
    ok = globalShortcut.register(newAccel, handler);
  } catch (err) {
    relayRegisterFailure(slot, newAccel, err.message || 'threw');
    // Re-register the previous binding for this slot so we don't end up with nothing.
    if (activeGlobals[slot]) {
      try { globalShortcut.register(activeGlobals[slot], handler); } catch {}
    }
    return activeGlobals[slot];
  }
  if (!ok) {
    relayRegisterFailure(slot, newAccel, 'OS rejected');
    if (activeGlobals[slot]) {
      try { globalShortcut.register(activeGlobals[slot], handler); } catch {}
    }
    return activeGlobals[slot];
  }
  return newAccel;
}

// Apply a full map: unregister-all then register each global slot (D-11).
function registerGlobalHotkeys(map) {
  globalShortcut.unregisterAll();
  for (const slot of GLOBAL_HOTKEY_SLOTS) {
    const requested = map && typeof map[slot] === 'string' ? map[slot] : DEFAULT_HOTKEYS[slot];
    // Phase 9 / HOTK-08: skip mouse/wheel-routed slots. globalShortcut cannot
    // register Mouse*/Wheel* tokens; feeding them here produces a spurious
    // "rejected by the OS" banner. mouse-hook.js owns dispatch for those.
    if (acceleratorIsMouseRouted(requested)) {
      activeGlobals[slot] = requested;
      // Clear any stale rejection banner for this slot by relaying an
      // empty-reason success signal — renderer treats null-reason as "OK".
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('hotkey-register-failed', { slot, accel: requested, reason: null });
      }
      continue;
    }
    activeGlobals[slot] = registerSingleGlobal(slot, requested);
  }
}

// Read config/hotkeys.json at startup. Returns a full seven-slot map, falling back
// to defaults on missing file or parse error. Only the three global slots are used
// here; the other four are needed so the renderer's keymap can be seeded on first
// page load via hotkeys_updated (the renderer fetches them itself from GET /api/config/hotkeys).
function loadHotkeysFromDisk() {
  const p = path.join(process.cwd(), 'config', 'hotkeys.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    const out = { ...DEFAULT_HOTKEYS };
    for (const slot of Object.keys(DEFAULT_HOTKEYS)) {
      if (typeof parsed[slot] === 'string') out[slot] = parsed[slot];
    }
    return out;
  } catch {
    return { ...DEFAULT_HOTKEYS };
  }
}

// Accelerator whitelist — same grammar as backend 03-01 `_validateAccelerator`.
// Defence-in-depth: renderer is trusted (contextIsolation=true) but IPC payloads
// from a compromised renderer should still not inject arbitrary strings into
// globalShortcut.register. Reject anything that doesn't parse.
const ACCEL_MODIFIERS = new Set([
  'CommandOrControl','CmdOrCtrl','Command','Cmd','Control','Ctrl',
  'Shift','Alt','Option','AltGr','Super','Meta',
]);
const ACCEL_NAMED_KEYS = new Set([
  'Left','Right','Up','Down','Space','Tab','Backspace','Delete','Insert','Home','End','PageUp','PageDown','Escape','Enter','Return',
  'Plus','numadd','numsub','nummult','numdiv','numdec','Capslock','Numlock','Scrolllock','PrintScreen',
  // Phase 9 / HOTK-08: mouse + wheel final-position tokens. Mirror of
  // src/controllers/config.controller.js HOTKEY_NAMED_KEYS extension (09-PATTERNS S2).
  // Mouse1 (left) + Mouse2 (right) deliberately absent per CONTEXT D-08.
  'Mouse3','Mouse4','Mouse5','WheelUp','WheelDown',
]);
// Phase 9 / HOTK-08: slots whose final token is a mouse/wheel accelerator are
// dispatched by electron/mouse-hook.js (uiohook-napi), NOT by globalShortcut.
// Feeding them to globalShortcut.register() always fails (electron does not
// recognise these tokens) and surfaces as a spurious "rejected by the OS" banner.
// Hoisted to module scope so both isValidAccelerator and registerGlobalHotkeys
// can share the whitelist (dual-dispatcher routing per CONTEXT D-01).
const MOUSE_FINAL_TOKENS = new Set(['Mouse3','Mouse4','Mouse5','WheelUp','WheelDown']);
function acceleratorIsMouseRouted(accel) {
  if (typeof accel !== 'string' || accel.length === 0) return false;
  const parts = accel.split('+');
  return MOUSE_FINAL_TOKENS.has(parts[parts.length - 1]);
}
function isValidAccelerator(accel) {
  if (accel === '') return true;  // empty = disabled
  if (typeof accel !== 'string' || accel.length > 64) return false;
  const parts = accel.split('+');
  if (!parts.length) return false;
  const last = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  for (const m of mods) if (!ACCEL_MODIFIERS.has(m)) return false;
  const keyOk = /^[A-Za-z0-9]$/.test(last) || /^F([1-9]|1[0-9]|2[0-4])$/.test(last) || ACCEL_NAMED_KEYS.has(last);
  if (!keyOk) return false;
  // Must include at least one non-Shift modifier — bare or Shift-only
  // accelerators hijack normal typing globally.
  // Phase 9 / HOTK-08: mouse/wheel final tokens do NOT hijack typing, so
  // skip the guard when the final token is one of them. Uses module-scope
  // MOUSE_FINAL_TOKENS so registerGlobalHotkeys can share the same whitelist.
  if (MOUSE_FINAL_TOKENS.has(last)) return true;
  return mods.some((m) => m !== 'Shift');
}

function sanitizeHotkeyMap(input) {
  const out = Object.create(null);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const slot of GLOBAL_HOTKEY_SLOTS) {
    const accel = input[slot];
    if (isValidAccelerator(accel)) out[slot] = accel;
    else out[slot] = DEFAULT_HOTKEYS[slot];
  }
  return out;
}

// Record-mode state — when the Settings page is capturing a new binding, globals are
// unregistered so the keystroke doesn't also fire the current binding's handler.
let captureResumeTimer = null;
const CAPTURE_AUTO_RESUME_MS = 10_000;

function resumeFromCapture() {
  if (captureResumeTimer) { clearTimeout(captureResumeTimer); captureResumeTimer = null; }
  // Re-register from the last-known-good map so we don't lose bindings that weren't
  // part of this save round (e.g. the user paused, then cancelled without saving).
  registerGlobalHotkeys(activeGlobals);
}

// ─── Tray menu build (04-01) ─────────────────────────────────────────
// Rebuilt on every state change that affects menu content:
//   1. HUD visibility changes (show / hide / closed events on overlayWindow)
//   2. Hotkey rebinds (existing ipcMain.on('hotkeys-updated', ...) handler)
//   3. Pidfile changes — NOT handled; readPidfile is one-shot at initTray time
//      per CONTEXT.md D-13 (restart spawns a fresh Electron process).
//
// Decision references:
//   D-01 — single adaptive Show/Hide HUD item
//   D-02 — HUD-toggle row shows accelerator hint from config/hotkeys.json
//   D-03 — one "Stop all" (no separate Quit)
//   D-04 — left-click = toggleOverlay (wired in initTray, not here)
//   D-16 — Restart disabled + tooltip when standalone (managedPids===null)
//   D-17 — Open logs folder uses shell.openPath(process.cwd() + '/logs')

// FIX-03: re-entrancy flag — prevents overlapping Menu.buildFromTemplate +
// tray.setContextMenu sequences from racing when hotkeys-updated arrives
// during a show/hide/closed transition.
let _rebuildingTrayMenu = false;

// FIX-03: click handlers in the returned template MUST remain late-binding —
// they capture no mutable state at buildFromTemplate time. toggleOverlay,
// onTrayRestart, onTrayStopAll are top-level function refs; each reads
// overlayWindow / managedPids at call-time, not at menu-build time.
// The only build-time-captured values are display-only (hudVisible label,
// hudAccel accelerator hint) — staleness of those is cosmetic, not
// correctness, and self-heals on the next rebuild.
function buildTrayMenu() {
  const hudVisible = overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
  const hotkeys = loadHotkeysFromDisk();
  // Accelerator field is DISPLAY-ONLY per D-02 — globalShortcut still owns the
  // real binding. Normalize CommandOrControl → Ctrl for Windows users.
  const hudAccel = (hotkeys.hud_toggle || 'CommandOrControl+Shift+H')
    .replace('CommandOrControl', 'Ctrl')
    .replace('CmdOrCtrl', 'Ctrl');

  return Menu.buildFromTemplate([
    {
      label: hudVisible ? 'Hide HUD' : 'Show HUD',
      accelerator: hudAccel,
      click: () => toggleOverlay(),
    },
    { type: 'separator' },
    {
      label: 'Open logs folder',
      click: () => {
        // D-17: path.join(process.cwd(), 'logs'). start.ps1:35 sets cwd to ScriptDir
        // so process.cwd() is the repo root. shell.openPath returns a Promise<string>
        // (empty on success, error message on failure) — log failures for diagnostics.
        const logsPath = path.join(process.cwd(), 'logs');
        shell.openPath(logsPath).then((result) => {
          if (result) console.warn('[tray] openPath(logs) failed:', result);
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Restart',
      enabled: Boolean(managedPids),
      toolTip: managedPids ? undefined : 'Requires start.bat launch',
      click: onTrayRestart,
    },
    { label: 'Stop all', click: onTrayStopAll },
  ]);
}

// FIX-03: single entry point for all tray-menu rebuild triggers.
// - No-op if tray is null (pre-initTray).
// - No-op if a rebuild is already running on this tick — the caller that
//   started the rebuild will read the current state at Menu.buildFromTemplate
//   time, which is at-most-one-tick stale. Any triggering events that fire
//   during the rebuild are implicitly coalesced into that single pass.
function scheduleTrayRebuild() {
  if (!tray) return;
  if (_rebuildingTrayMenu) return;
  _rebuildingTrayMenu = true;
  try {
    tray.setContextMenu(buildTrayMenu());
  } finally {
    _rebuildingTrayMenu = false;
  }
}

// ─── Shutdown-drain HTTP call (gap 05-06, closes GAP-05-01-shutdown-drain) ───
// Windows-portable graceful drain: the Node backend cannot receive SIGTERM from
// Electron's gracefulKill (see line 61-64 comment — process.kill on Win32 is
// TerminateProcess, not a signal). Instead we POST to the backend's HTTP
// shutdown endpoint, which awaits sessionRecorder.shutdown('app_shutdown') +
// resolves 200 only AFTER the JSONL session_end footer is on disk.
//
// 3-second timeout because a totally unresponsive Node shouldn't block tray
// Stop all. gracefulKill still runs right after (SIGTERM + 600ms + taskkill
// /F /T /PID) so the process dies one way or another.
function postShutdownDrain(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 4000,
      path: '/api/shutdown',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '0' },
      timeout: timeoutMs,
    }, (res) => {
      // Drain body (otherwise socket may stay half-open); we don't care about content.
      res.on('data', () => {});
      res.on('end', () => {
        console.log('[tray] shutdown drain ok, status=', res.statusCode);
        resolve(true);
      });
    });
    req.on('timeout', () => {
      console.warn('[tray] shutdown drain timed out after', timeoutMs, 'ms — proceeding to kill');
      req.destroy();
      resolve(false);
    });
    req.on('error', (err) => {
      // ECONNREFUSED is normal if backend already dead — not an error for our purposes.
      console.warn('[tray] shutdown drain request failed:', err.code || err.message);
      resolve(false);
    });
    req.end();
  });
}

// ─── Stop all (04-03, D-14) ──────────────────────────────────────────────
// Order: Python → Node → Ollama (if managed) → app.quit().
// Python-first avoids Socket.IO reconnect spam in transcriber-err.log
// (04-RESEARCH.md §"Pitfall 4"). Callbacks chain to preserve order.
async function onTrayStopAll() {
  if (!managedPids) {
    // Standalone mode (D-16): no PIDs to kill, just quit Electron.
    // Still attempt drain in case the user launched Node via npm-start standalone —
    // harmless if backend is absent (ECONNREFUSED → resolves false fast).
    console.log('[tray] Stop all (standalone) — drain + app.quit()');
    await postShutdownDrain(3000);
    app.quit();
    return;
  }
  console.log('[tray] Stop all (managed) — drain → Python → Node → Ollama → app.quit()');
  // GAP-05-01 fix: drain JSONL session_end BEFORE killing Node. postShutdownDrain
  // resolves once the backend has awaited sessionRecorder.shutdown('app_shutdown').
  await postShutdownDrain(3000);
  gracefulKill(managedPids.pyPid, 'python', () => {
    gracefulKill(managedPids.nodePid, 'node', () => {
      if (managedPids.ollamaStartedByScript && managedPids.ollamaPid) {
        gracefulKill(managedPids.ollamaPid, 'ollama', () => app.quit());
      } else {
        app.quit();
      }
    });
  });
}

// ─── Restart (04-03, D-15) ───────────────────────────────────────────────
// Only fires in managed mode — 04-01's buildTrayMenu renders Restart.enabled
// = Boolean(managedPids), so standalone mode can't click this. Belt-and-suspenders
// early-return handles any race.
//
// Sequence (per 04-RESEARCH.md §"Open Questions" #4 and §Q3):
//   1. DELETE logs/.electron-ready — critical, otherwise the new start.ps1
//      reads the stale sentinel from the old Electron and hides too early.
//   2. Spawn fresh start.bat via cmd.exe /c start "" — detached + stdio: 'ignore'
//      + windowsHide: true. The new start.ps1 runs Stop-StaleServices which
//      cleans up any leftover PIDs idempotently.
//   3. Run onTrayStopAll — kills this generation's PIDs + app.quit().
//
// Brief console flash (~1-2s) during Restart is EXPECTED — Node bug #21825
// makes windowsHide unreliable with detached:true (04-RESEARCH.md §Pitfall 3).
// Documented in 04-HUMAN-UAT.md preamble.
function onTrayRestart() {
  if (!managedPids) return;   // Defensive — should never fire (menu item disabled)

  // Step 1: delete the stale sentinel BEFORE spawning the new start.bat
  try {
    const readyPath = path.join(process.cwd(), 'logs', '.electron-ready');
    fs.unlinkSync(readyPath);
    console.log('[tray] Restart: deleted stale .electron-ready sentinel');
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn('[tray] Restart: sentinel cleanup failed:', err.message);
    }
  }

  // Step 2: spawn detached start.bat. argv-element form (not shell: true) to
  // avoid shell-injection surface even though we have no dynamic args.
  try {
    const child = cpSpawn('cmd.exe', ['/c', 'start', '""', 'start.bat'], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,   // best-effort; Node #21825 makes this flaky with detached
    });
    child.unref();
    console.log('[tray] Restart: spawned fresh start.bat');
  } catch (err) {
    console.error('[tray] Restart: respawn failed:', err && err.message);
    // Fall through to Stop all anyway — we don't want to leave the user in
    // a half-stopped state. Worst case: user has to manually run start.bat.
  }

  // Step 3: kill this generation's PIDs + app.quit(). The fresh start.ps1's
  // Stop-StaleServices is idempotent — if our kills succeed, the new
  // start.ps1 will just see "No stale services to clean up."
  onTrayStopAll();
}

// ─── Ready sentinel (04-02, D-09 Electron side) ──────────────────────────────
// Writes logs/.electron-ready once app.whenReady fires AND initTray completes.
// start.ps1 polls for this file (Wait-ForElectronReady) as its third readiness
// check before calling SW_HIDE on the console. File is deleted by start.ps1's
// finally block and by Plan 04-03's onTrayRestart BEFORE it spawns a fresh
// start.bat (otherwise the new start.ps1 reads a stale sentinel from the
// previous run and hides too early — see 04-RESEARCH.md §"Open Questions" #4).
//
// Non-fatal on failure: if the logs dir isn't writable, start.ps1's 15-second
// Wait-ForElectronReady simply times out and Die's — console stays visible,
// user sees the error. Graceful degradation by design.
function writeReadySentinel() {
  try {
    const logsDir = path.join(process.cwd(), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const readyPath = path.join(logsDir, '.electron-ready');
    fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } catch (err) {
    console.warn('[tray] ready sentinel write failed:', err && err.message);
  }
}

// ─── Tray init (04-01) ───────────────────────────────────────────────
// MUST be called from inside app.whenReady().then(...) — see 04-RESEARCH.md §Q4
// "Create tray instance after the 'ready' event is fired" [CITED: Electron Tray docs].
function initTray() {
  // __dirname-based path per 04-RESEARCH.md Pitfall 5 (CWD-relative paths break
  // when Electron is launched from a different directory, e.g. `npm run hud`
  // from a subshell).
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.ico');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      console.warn('[tray] icon empty at', iconPath, '— tray will be clickable but invisible');
      icon = nativeImage.createEmpty();
    }
  } catch (err) {
    console.warn('[tray] icon load threw:', err && err.message);
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('SolveWatch AI');
  tray.setContextMenu(buildTrayMenu());
  // D-04: left-click toggles HUD (same entry point as Ctrl+Shift+H and Show/Hide menu item)
  tray.on('click', () => toggleOverlay());
}

app.whenReady().then(() => {
  const initialMap = loadHotkeysFromDisk();
  registerGlobalHotkeys(initialMap);

  // 04-03: read pidfile BEFORE initTray so buildTrayMenu's Restart.enabled
  // reflects managed-vs-standalone mode (D-16). One-shot read; restart spawns
  // a fresh Electron process that reads a fresh pidfile.
  managedPids = readPidfile();
  if (managedPids) {
    console.log('[tray] managed mode — nodePid=', managedPids.nodePid, 'pyPid=', managedPids.pyPid);
  } else {
    console.log('[tray] standalone mode — no pidfile or stale; Restart will be disabled');
  }

  // 04-01: create tray icon + context menu AFTER globalShortcut registration so
  // buildTrayMenu()'s accelerator-hint read reflects the live map.
  initTray();

  // ─── POLISH-02 D-05: eager createOverlayWindow ─────────────────────────
  // Was lazy (created on first Ctrl+Shift+H). Eager now so the window is ready
  // to paint while start.ps1 is still polling Wait-ForElectronReady — closes
  // the visible gap between console-hide and HUD-appear on cold launch.
  createOverlayWindow();

  // ─── POLISH-02 D-06 + D-07: ready-to-show gate + 15s watchdog ──────────
  // Sentinel fires ONCE — either from the ready-to-show handler (primary path,
  // wired inside createOverlayWindow above) or from the 15s watchdog fallback
  // (RESEARCH §Pitfall 3). start.ps1's Wait-ForElectronReady ceiling is 15s
  // (Phase 4 D-09); the inner watchdog must match. If the renderer crashes
  // before first paint, the 15s ceiling expires, sentinel lands, start.ps1
  // hides the console, and the user sees a black screen — better than a 15s
  // hung start.ps1 with no diagnostic.
  let sentinelWritten = false;
  global.__hudWriteOnceSentinel = () => {
    if (sentinelWritten) return;
    sentinelWritten = true;
    writeReadySentinel();
  };
  setTimeout(() => {
    if (!sentinelWritten) {
      console.warn('[hud] ready-to-show did not fire within 15s — writing sentinel anyway (watchdog)');
      global.__hudWriteOnceSentinel();
    }
  }, 15_000);

  // Phase 9 / HOTK-08: initialise the mouse-hook dispatcher. Handlers attach
  // once and persist across pause/resume cycles (spike §2). init is a
  // silent no-op on darwin (CONTEXT D-13 handled inside the module).
  try {
    mouseHook.init({ handlerForSlot });
  } catch (err) {
    console.warn('[mouse-hook] init threw:', err && err.message);
  }

  // Listen for live-reload requests from the HUD renderer (relay of Socket.IO
  // hotkeys_updated — see 03-03 renderer + 03-01 backend emit).
  ipcMain.on('hotkeys-updated', (_ev, incomingMap) => {
    const safe = sanitizeHotkeyMap(incomingMap);
    // Phase 9 / HOTK-08 (CONTEXT D-11): dual-dispatcher fan-out.
    // Independent try/catch so a failure in one dispatcher doesn't prevent
    // the other from re-registering.
    try {
      registerGlobalHotkeys(safe);
    } catch (err) {
      console.warn('[hotkey] keyboard re-register failed:', err && err.message);
    }
    try {
      mouseHook.rebuildLookup(safe);
    } catch (err) {
      console.warn('[mouse-hook] lookup rebuild failed:', err && err.message);
    }
    // 04-01 (D-02 integration): refresh accelerator hint after rebind.
    // The Phase 3 D-11 handler already runs registerGlobalHotkeys — this line
    // appends the tray-side effect so the menu "Hide HUD Ctrl+Shift+Q" label
    // updates to whatever hud_toggle was just saved.
    scheduleTrayRebuild();
    // If a pause is in-flight, supersede it — a save finished, bindings are fresh.
    if (captureResumeTimer) { clearTimeout(captureResumeTimer); captureResumeTimer = null; }
  });

  // Pause/resume globalShortcut during Settings record mode (Gap A closure).
  // Without this, capturing e.g. Ctrl+Shift+H in the Settings page also fires the
  // HUD toggle because globalShortcut intercepts keys at the OS level before the
  // browser's preventDefault can see them.
  ipcMain.on('hotkeys-capture-pause', (_ev, paused) => {
    if (paused) {
      globalShortcut.unregisterAll();
      // Phase 9 / HOTK-08 (CONTEXT D-11 + spike L4):
      // uiohook is NOT touched by globalShortcut.unregisterAll — must pause explicitly
      // or a recorded Mouse4 in Settings also fires the current Mouse4 binding.
      try { mouseHook.pause(); } catch (err) { console.warn('[mouse-hook] pause error:', err && err.message); }
      // Safety: auto-resume if the Settings page disappears without telling us.
      if (captureResumeTimer) clearTimeout(captureResumeTimer);
      captureResumeTimer = setTimeout(resumeFromCapture, CAPTURE_AUTO_RESUME_MS);
    } else {
      resumeFromCapture();
      try { mouseHook.resume(); } catch (err) { console.warn('[mouse-hook] resume error:', err && err.message); }
    }
  });

  // ─── 06-05 POLISH add-on: open-settings IPC (D-14) ───────────────────
  // Renderer can request the settings page opens in the user's default browser.
  // URL is a hardcoded string literal — renderer cannot influence it (D-14 +
  // RESEARCH §Security Domain: "new open-settings channel accepts no payload,
  // so even a compromised renderer can't make main open an arbitrary URL").
  // shell.openExternal returns a Promise<undefined> on success; .catch logs
  // the rare failure mode where the user's Windows 11 install has no default
  // http handler registered (RESEARCH §Pitfall 6).
  ipcMain.on('open-settings', () => {
    shell.openExternal('http://localhost:4000/settings')
      .catch((err) => console.warn('[hud] open-settings shell.openExternal failed:', err && err.message));
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Phase 9 / HOTK-08: mouse-hook shutdown alongside tray cleanup.
  try { mouseHook.shutdown(); } catch {}
  // 04-01: Electron auto-cleans tray icons on process exit, but explicit destroy
  // avoids rare "dangling icon" reports on fast restarts per Electron #8597.
  if (tray) {
    try { tray.destroy(); } catch {}
    tray = null;
  }
});
