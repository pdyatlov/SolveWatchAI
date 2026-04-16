const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hudAPI', {
  startDrag: (screenX, screenY) =>
    ipcRenderer.send('hud-drag-start', screenX, screenY),
  dragMove: (screenX, screenY) =>
    ipcRenderer.send('hud-drag-move', screenX, screenY),
  endDrag: () => ipcRenderer.send('hud-drag-end'),
  // value: 0 (opaque) → 100 (transparent)
  setOpacity: (value) => ipcRenderer.send('hud-set-opacity', value),
  // Register a callback for the toggle-listen IPC message (Cmd+Shift+X)
  onToggleListen: (callback) => ipcRenderer.on('toggle-listen', callback),

  // NEW (Phase 3) ------------------------------------------------------
  // Forward the full seven-slot hotkey map to main for globalShortcut re-registration.
  // `map` shape: { hud_toggle: "CommandOrControl+Shift+H", listen_toggle: "...", ... }.
  // IPC channel is 'hotkeys-updated' (kebab-case, per D-19), distinct from the
  // Socket.IO event name 'hotkeys_updated' (snake_case, per D-18).
  updateHotkeys: (map) => ipcRenderer.send('hotkeys-updated', map),

  // Subscribe to per-slot register-failure notifications pushed from main after
  // globalShortcut.register returns false. Callback receives { slot, accel, reason }.
  onHotkeyRegisterFailed: (callback) =>
    ipcRenderer.on('hotkey-register-failed', (_ev, data) => callback(data)),

  // Pause/resume global shortcuts while the Settings page is in record mode
  // (so capturing e.g. Ctrl+Shift+H doesn't also fire the HUD toggle).
  // Main process unregisters all on pause, re-registers from its last-known good
  // map on resume. Includes a 10s auto-resume safety net in main.
  setCapturePause: (paused) => ipcRenderer.send('hotkeys-capture-pause', !!paused),

  // Navigate Q&A history (Prev/Next). Fired by Electron main when the user presses
  // the configured accelerator regardless of window focus.
  // `delta` is -1 (prev) or +1 (next).
  onNavigate: (callback) =>
    ipcRenderer.on('navigate', (_ev, delta) => callback(delta)),

  // Scroll the current answer bubble. Fired by Electron main.
  // `delta` is a pixel offset: negative scrolls up, positive scrolls down.
  onScrollAnswer: (callback) =>
    ipcRenderer.on('scroll-answer', (_ev, delta) => callback(delta)),

  // NEW (06-05 POLISH add-on — D-14, D-16) --------------------------------
  // Opens the settings page in the user's default browser via main-process
  // shell.openExternal. Zero-argument API — the renderer cannot pass a URL,
  // preventing any SSRF / open-redirect surface if a compromised renderer
  // tried to exfil via javascript:/file:/arbitrary URLs. The actual URL
  // literal lives in electron/main.js only (RESEARCH §Security Domain V14
  // + Pitfall 6).
  openSettings: () => ipcRenderer.send('open-settings'),
});
