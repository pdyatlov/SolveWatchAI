/**
 * SessionRecorder — Per-interview-session JSONL writer.
 *
 * Lifecycle (Phase 5 / Plan 05-01 / D-01):
 *  - Lazy-start on first interviewer ('them') utterance after Listen-on.
 *  - Listen-off does NOT close. Only the 10-minute idle timer or app shutdown closes.
 *  - Re-toggling Listen within the idle window appends to the same file (single
 *    session_start, single file per logical interview).
 *
 * Filename (D-04):
 *  - Starts as `<ISO-timestamp>.jsonl` (colons + dots replaced with hyphens for Windows).
 *  - On the first 'them' utterance, atomically renamed to `<timestamp>-<slug>.jsonl`
 *    where slug is sanitized (lowercase, ASCII-only, hyphens, ~40-char cap).
 *  - If no 'them' utterance ever arrives, filename stays timestamp-only.
 *
 * Append safety:
 *  - One queue + setImmediate batching, mirroring src/utils/file-logger.js.
 *  - Existence check before each append (defensive against external delete from
 *    DELETE /api/sessions/:id in Plan 05-04).
 *
 * Shutdown:
 *  - shutdown(reason) drains the queue and writes session_end before resolving.
 *  - Wired into src/server.js gracefulShutdown so SIGINT/SIGTERM persists the footer.
 */
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

const log = logger('SessionRecorder');

const SESSIONS_DIR = path.join(process.cwd(), 'logs', 'sessions');
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;       // D-01: 10-minute idle window
const SLUG_MAX_LEN = 40;                       // D-04: ~40-char cap

// Ensure directory exists at module load (sync once, mirrors file-logger.js line 19).
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

class SessionRecorder {
  constructor() {
    this._activeSession = null;
    // _activeSession shape: { path, timestamp, startMs, utteranceCount, renamed }
    this._queue = [];
    this._flushing = false;
    this._idleTimer = null;
    this._profileSnapshotProvider = null;   // injected by Plan 05-02 via setProfileProvider
    this._settingsSnapshotProvider = null;  // injected at namespace setup (Task 2)
  }

  // ── Injection points (kept simple — no event bus) ─────────────────
  setProfileProvider(fn)  { this._profileSnapshotProvider  = typeof fn === 'function' ? fn : null; }
  setSettingsProvider(fn) { this._settingsSnapshotProvider = typeof fn === 'function' ? fn : null; }

  // ── Public API ────────────────────────────────────────────────────

  async start() {
    if (this._activeSession) return;
    const startDate = new Date();
    // Windows-safe filename timestamp: replace ':' and '.' with '-'.
    // Reserved chars on Windows: < > : " / \ | ? *  (only ':' and '.' show up in ISO timestamps).
    const tsForFilename = startDate.toISOString().replace(/[:.]/g, '-');
    const startFilePath = path.join(SESSIONS_DIR, `${tsForFilename}.jsonl`);

    const profileSnapshot  = this._profileSnapshotProvider  ? this._profileSnapshotProvider()  : '';
    const settingsSnapshot = this._settingsSnapshotProvider ? this._settingsSnapshotProvider() : {};

    this._activeSession = {
      path: startFilePath,
      timestamp: tsForFilename,
      startMs: Date.now(),
      utteranceCount: 0,
      renamed: false,
      // `created` flips to true after the first successful appendFile callback so the
      // defensive existsSync guard in _enqueue knows when "missing file" actually
      // means "deleted underneath us" vs "not yet created on first append".
      created: false,
    };

    this._enqueue({
      type: 'session_start',
      start_ts: startDate.toISOString(),
      unix_ts: Math.floor(startDate.getTime() / 1000),
      profile_snapshot: profileSnapshot,
      settings_snapshot: settingsSnapshot,
    });

    this._resetIdleTimer();
    log.info('Session started', { file: path.basename(startFilePath) });
  }

  recordUtterance({ speaker, text, ts }) {
    if (!text || (speaker !== 'them' && speaker !== 'me')) return;
    if (!this._activeSession) {
      // Lazy-start per Claude's Discretion B: first interviewer_speech opens the session.
      // (Listen-on alone does NOT open a session; only the first utterance does.)
      this.start();
    }
    const eventTs = ts || new Date().toISOString();
    this._enqueue({
      type: 'utterance',
      ts: eventTs,
      unix_ts: Math.floor(new Date(eventTs).getTime() / 1000),
      speaker,
      text,
    });
    this._activeSession.utteranceCount += 1;
    this._resetIdleTimer();

    // First 'them' utterance → rename file to <timestamp>-<slug>.jsonl (per D-04).
    if (speaker === 'them' && !this._activeSession.renamed) {
      this._renameToSlug(text);
    }
  }

  recordAiAnswer({ text, provider, model, promptType, questionRef, ts }) {
    if (!this._activeSession || !text) return;
    const eventTs = ts || new Date().toISOString();
    this._enqueue({
      type: 'ai_answer',
      ts: eventTs,
      unix_ts: Math.floor(new Date(eventTs).getTime() / 1000),
      speaker: 'ai',
      text,
      provider: provider || 'unknown',
      model: model || null,
      prompt_type: promptType || 'interview-answer',
      question_ref: questionRef || null,
    });
    this._resetIdleTimer();
  }

  recordScreenshotQa({ ocrText, aiAnswer, provider, model, promptType, screenshotPath, ts }) {
    // Per Claude's Discretion A: open ephemeral session if none active.
    if (!this._activeSession) {
      this.start();
    }
    const eventTs = ts || new Date().toISOString();
    this._enqueue({
      type: 'screenshot_qa',
      ts: eventTs,
      unix_ts: Math.floor(new Date(eventTs).getTime() / 1000),
      speaker: 'ai',
      ocr_text: ocrText || '',
      ai_answer: aiAnswer || '',
      provider: provider || 'unknown',
      model: model || null,
      prompt_type: promptType || 'system',
      screenshot_path: screenshotPath || null,
    });
    this._resetIdleTimer();
    // Note: we do NOT immediately close screenshot-only sessions in this version.
    // The next idle timeout will close it normally with reason 'idle_timeout'.
    // (Could be 'screenshot_oneoff' in a future enhancement — left as TODO.)
  }

  onListenStateChanged({ listening }) {
    // Per D-01: Listen-off does NOT close. Only idle timeout closes.
    // This hook exists so future logic can react if needed.
    log.debug('Listen state changed', { listening });
  }

  async shutdown(reason = 'app_shutdown') {
    if (!this._activeSession) return;
    await this._closeSession(reason);
  }

  // ── Internals ─────────────────────────────────────────────────────

  _resetIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      this._closeSession('idle_timeout').catch((err) =>
        log.error('Error closing session on idle', { error: err.message })
      );
    }, IDLE_TIMEOUT_MS);
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  async _closeSession(reason) {
    if (!this._activeSession) return;
    const session = this._activeSession;
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }

    const endDate = new Date();
    const endEvent = {
      type: 'session_end',
      ts: endDate.toISOString(),
      unix_ts: Math.floor(endDate.getTime() / 1000),
      reason,
      utterance_count: session.utteranceCount,
      duration_s: Math.round((endDate.getTime() - session.startMs) / 1000),
      end_ts: endDate.toISOString(),
    };

    // Drain queue + write footer via Promise so shutdown can await it.
    await new Promise((resolve) => {
      this._queue.push(JSON.stringify(endEvent) + '\n');
      this._flushNow(resolve);
    });

    log.info('Session closed', {
      file: path.basename(session.path),
      reason,
      utterances: session.utteranceCount,
      duration_s: endEvent.duration_s,
    });
    this._activeSession = null;
  }

  _enqueue(event) {
    if (!this._activeSession) return;
    // Defensive: if file vanished AFTER it was created (deleted via DELETE /api/sessions/:id
    // in Plan 05-04), skip. Skip the check on the cold-start case where the file legitimately
    // doesn't exist yet because fs.appendFile is what creates it on first write.
    if (this._activeSession.created && !fs.existsSync(this._activeSession.path)) {
      log.warn('Active session file missing, skipping append', { path: this._activeSession.path });
      return;
    }
    this._queue.push(JSON.stringify(event) + '\n');
    if (!this._flushing) {
      this._flushing = true;
      setImmediate(() => this._flush());
    }
  }

  _flush() {
    if (this._queue.length === 0) { this._flushing = false; return; }
    if (!this._activeSession) { this._flushing = false; this._queue.length = 0; return; }
    const batch = this._queue.splice(0, this._queue.length).join('');
    const filePath = this._activeSession.path;
    const sessionAtCallTime = this._activeSession;
    fs.appendFile(filePath, batch, (err) => {
      if (err) log.error('Session append error', { path: filePath, error: err.message });
      else if (sessionAtCallTime === this._activeSession) {
        sessionAtCallTime.created = true;
        this._applyPendingRename();
      }
      if (this._queue.length > 0) setImmediate(() => this._flush());
      else this._flushing = false;
    });
  }

  _flushNow(resolve) {
    // Final flush variant for shutdown — invokes resolve after the appendFile callback.
    if (this._queue.length === 0) { this._flushing = false; resolve(); return; }
    if (!this._activeSession) { this._flushing = false; this._queue.length = 0; resolve(); return; }
    const batch = this._queue.splice(0, this._queue.length).join('');
    const filePath = this._activeSession.path;
    const sessionAtCallTime = this._activeSession;
    fs.appendFile(filePath, batch, (err) => {
      if (err) log.error('Session shutdown append error', { path: filePath, error: err.message });
      else if (sessionAtCallTime === this._activeSession) {
        sessionAtCallTime.created = true;
        this._applyPendingRename();
      }
      if (this._queue.length > 0) this._flushNow(resolve);
      else { this._flushing = false; resolve(); }
    });
  }

  _applyPendingRename() {
    if (!this._activeSession || this._activeSession.renamed) return;
    if (!this._activeSession._pendingSlug) return;
    const slug = this._activeSession._pendingSlug;
    this._activeSession._pendingSlug = null;
    const newPath = path.join(SESSIONS_DIR, `${this._activeSession.timestamp}-${slug}.jsonl`);
    try {
      fs.renameSync(this._activeSession.path, newPath);  // safe on Windows per RESEARCH Q.1
      this._activeSession.path = newPath;
      this._activeSession.renamed = true;
      log.info('Session file renamed', { to: path.basename(newPath) });
    } catch (err) {
      log.warn('Could not rename session file', { error: err.message });
      this._activeSession.renamed = true;  // don't keep retrying
    }
  }

  _renameToSlug(themText) {
    if (!this._activeSession || this._activeSession.renamed) return;
    const safe = String(themText)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_MAX_LEN);
    if (safe.length < 2) {
      // Pitfall 5: empty/too-short slug → keep timestamp-only filename.
      this._activeSession.renamed = true;  // mark so we don't retry on every utterance
      return;
    }
    // Defer the actual fs.renameSync until after the first append flushes — otherwise
    // the rename can race ahead of the queued session_start write and ENOENT.
    // _applyPendingRename() runs from inside the appendFile callback once the file
    // is confirmed on disk (created === true).
    this._activeSession._pendingSlug = safe;
    if (this._activeSession.created) {
      // File already exists on disk (e.g. a follow-up 'them' utterance) — apply now.
      this._applyPendingRename();
    }
  }

  // ── Read accessors used by Plan 05-03/04/05 (no behavior here, just expose) ──
  getActiveSessionPath() { return this._activeSession?.path || null; }
  getSessionsDir()       { return SESSIONS_DIR; }
}

export default new SessionRecorder();
