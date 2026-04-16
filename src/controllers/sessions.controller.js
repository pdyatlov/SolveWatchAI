/**
 * SessionsController — REST endpoints for session history (Phase 5 / Plans 05-03, 05-04).
 *
 * Endpoints:
 *   GET    /api/sessions                          → list all sessions (newest-first)
 *   DELETE /api/sessions/:id                      → unlink a single session JSONL file
 *   GET    /api/sessions/:id                      → parsed events + metadata (Plan 05-04)
 *   GET    /api/sessions/:id/export.md            → D-08 Markdown export (Plan 05-04)
 *   GET    /api/sessions/:id/export.jsonl         → byte-identical raw stream (Plan 05-04)
 *   GET    /api/sessions/screenshots/:basename    → hardened image proxy (Plan 05-04)
 *
 * Plan 05-05 will add:
 *   POST /api/sessions/:id/retrospective (AI critique stream trigger)
 *
 * Security (T-05-03-01 / T-05-04-01..03 / path-traversal mitigation):
 *   Two-layer defense on every :id path parameter:
 *     1. _validateId — strict regex + reject `..`, `/`, `\`, absolute paths.
 *     2. _resolveSessionPath — path.resolve + prefix check against SESSIONS_DIR.
 *   Both checks must pass before any filesystem operation.
 *   Screenshot proxy uses an analogous two-layer defense:
 *     1. SCREENSHOT_BASENAME_REGEX — limited charset + .png/.jpg/.jpeg/.webp only.
 *     2. path.resolve + prefix check against the configured screenshots directory.
 *
 * Stats reading (D-03 / D-15):
 *   List endpoint reads only the first line + walks BACKWARD for the last
 *   `session_end` line (Plan 05-05 may append `retrospective` events AFTER
 *   `session_end`, so the last line of file is NOT guaranteed to be `session_end`).
 */
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import sessionRecorder from '../services/session-recorder.service.js';
import aiService from '../services/ai.service.js';

const log = logger('SessionsController');

const SESSIONS_DIR = path.join(process.cwd(), 'logs', 'sessions');

// D-04 / RESEARCH Open Question 1 — Windows-safe ISO timestamp + optional slug + .jsonl
// Filename example: 2026-04-16T10-30-00-000Z-what-is-the-time-complexity.jsonl
// (Colons + dots in the ISO timestamp are pre-replaced with hyphens by SessionRecorder.)
const SESSION_ID_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-[a-z0-9-]{1,40})?\.jsonl$/;

// T-05-04-03 mitigation — screenshot proxy basename grammar.
// Limited charset + extension whitelist; regex tested against `..`, `/`, `\`.
const SCREENSHOT_BASENAME_REGEX = /^[A-Za-z0-9._-]{1,128}\.(?:png|jpe?g|webp)$/i;

// Server-side broadcast hook for retrospective_* events (D-13). dataHandler registers
// itself here on construction so the controller can emit on /data-updates without a
// circular import. Mirrors config.controller.js _hotkeyBroadcaster pattern.
let _retrospectiveBroadcaster = null;
export function registerRetrospectiveBroadcaster(fn) {
  _retrospectiveBroadcaster = typeof fn === 'function' ? fn : null;
}

class SessionsController {

  // ── ID validation (security: path traversal mitigation T-05-03-01) ──
  _validateId(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) return false;
    if (id.includes('..') || id.includes('/') || id.includes('\\')) return false;
    if (path.isAbsolute(id)) return false;
    if (!SESSION_ID_REGEX.test(id)) return false;
    return true;
  }

  _resolveSessionPath(id) {
    // Final defense: resolve and verify the result is INSIDE SESSIONS_DIR.
    const candidate = path.resolve(SESSIONS_DIR, id);
    const baseResolved = path.resolve(SESSIONS_DIR);
    // path.resolve normalises separators; on Windows compare case-insensitively
    // for the prefix match (NTFS is case-insensitive).
    const within = process.platform === 'win32'
      ? candidate.toLowerCase().startsWith(baseResolved.toLowerCase() + path.sep.toLowerCase())
      : candidate.startsWith(baseResolved + path.sep);
    if (!within) return null;
    return candidate;
  }

  // ── First-line + last-session_end stats reader (D-03 / D-15) ──────
  async _readSessionStats(filePath, filename) {
    try {
      const stat = await fs.promises.stat(filePath);
      const content = await fs.promises.readFile(filePath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return null;

      let startEvent = null;
      try { startEvent = JSON.parse(lines[0]); } catch { /* malformed first line */ }
      if (!startEvent || startEvent.type !== 'session_start') return null;

      // D-15: walk backward — retrospective lines may appear AFTER session_end
      let endEvent = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.type === 'session_end') { endEvent = parsed; break; }
        } catch { /* skip malformed */ }
      }

      const isActive = endEvent === null && sessionRecorder.getActiveSessionPath() === filePath;

      return {
        id:              filename,
        start_ts:        startEvent.start_ts || null,
        duration_s:      endEvent ? endEvent.duration_s    : null,
        utterance_count: endEvent ? endEvent.utterance_count : null,
        size_bytes:      stat.size,
        status:          isActive ? 'active' : (endEvent ? 'closed' : 'orphaned'),
      };
    } catch (err) {
      log.warn('Could not read session stats', { filename, error: err.message });
      return null;
    }
  }

  // ── GET /api/sessions ─────────────────────────────────────────────
  async list(req, res) {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) {
        return res.json({ success: true, sessions: [] });
      }
      const files = await fs.promises.readdir(SESSIONS_DIR);
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl') && this._validateId(f));

      const stats = [];
      for (const filename of jsonlFiles) {
        const filePath = path.join(SESSIONS_DIR, filename);
        const s = await this._readSessionStats(filePath, filename);
        if (s) stats.push(s);
      }

      // Newest-first by start_ts (fallback to id which contains the ISO timestamp).
      stats.sort((a, b) => {
        const ka = a.start_ts || a.id;
        const kb = b.start_ts || b.id;
        return kb.localeCompare(ka);
      });

      return res.json({ success: true, sessions: stats });
    } catch (err) {
      log.error('Error listing sessions', err);
      return res.status(500).json({ success: false, error: 'Failed to list sessions' });
    }
  }

  // ── DELETE /api/sessions/:id ─────────────────────────────────────
  async remove(req, res) {
    try {
      const { id } = req.params;
      if (!this._validateId(id)) {
        return res.status(400).json({ success: false, error: 'Invalid session id' });
      }
      const filePath = this._resolveSessionPath(id);
      if (!filePath) {
        return res.status(400).json({ success: false, error: 'Invalid session path' });
      }
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }
      // If user deletes the active session, the next sessionRecorder._enqueue will see
      // existsSync(false) (with `created === true`) and skip — no crash. New utterances
      // will not auto-recreate the file (start() opens a fresh file with a new timestamp).
      await fs.promises.unlink(filePath);
      log.info('Session deleted', { id });
      return res.json({ success: true });
    } catch (err) {
      log.error('Error deleting session', err);
      return res.status(500).json({ success: false, error: 'Failed to delete session' });
    }
  }

  // ── GET /api/sessions/:id ─────────────────────────────────────────
  // Returns parsed events array + metadata (start_ts, profile_snapshot,
  // settings_snapshot, end, retrospective) for the session detail modal.
  async detail(req, res) {
    try {
      const { id } = req.params;
      if (!this._validateId(id)) {
        return res.status(400).json({ success: false, error: 'Invalid session id' });
      }
      const filePath = this._resolveSessionPath(id);
      if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }

      const content = await fs.promises.readFile(filePath, 'utf8');
      const events = [];
      let startEvent = null;
      let endEvent = null;
      let latestRetro = null;
      const retroEvents = [];

      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        events.push(parsed);
        if (parsed.type === 'session_start') startEvent = parsed;
        else if (parsed.type === 'session_end') endEvent = parsed;
        else if (parsed.type === 'retrospective') retroEvents.push(parsed);
      }

      // D-15: pick latest non-superseded retrospective.
      if (retroEvents.length > 0) {
        const supersededTs = new Set(retroEvents.map((r) => r.supersedes_ts).filter(Boolean));
        const candidates = retroEvents.filter((r) => !supersededTs.has(r.ts));
        latestRetro = candidates.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))[0] || null;
      }

      return res.json({
        success: true,
        id,
        start_ts:          startEvent ? startEvent.start_ts : null,
        profile_snapshot:  startEvent ? (startEvent.profile_snapshot || '') : '',
        settings_snapshot: startEvent ? (startEvent.settings_snapshot || {}) : {},
        end:               endEvent || null,
        retrospective:     latestRetro,
        events,
      });
    } catch (err) {
      log.error('Error reading session detail', err);
      return res.status(500).json({ success: false, error: 'Failed to read session' });
    }
  }

  // ── GET /api/sessions/:id/export.jsonl ──────────────────────────
  // Streams the raw JSONL file byte-identically with attachment header.
  async exportJsonl(req, res) {
    try {
      const { id } = req.params;
      if (!this._validateId(id)) {
        return res.status(400).json({ success: false, error: 'Invalid session id' });
      }
      const filePath = this._resolveSessionPath(id);
      if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }
      // T-05-04-02: defense-in-depth header injection scrub (regex already rejects CR/LF/quote/backslash).
      const safeName = id.replace(/[\r\n"\\]/g, '');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      fs.createReadStream(filePath)
        .on('error', (err) => {
          log.error('JSONL export stream error', { id, error: err.message });
          if (!res.headersSent) res.status(500).end();
        })
        .pipe(res);
    } catch (err) {
      log.error('Error exporting JSONL', err);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to export' });
    }
  }

  // ── GET /api/sessions/:id/export.md ─────────────────────────────
  // Renders the JSONL into D-08 Markdown structure and returns it.
  async exportMarkdown(req, res) {
    try {
      const { id } = req.params;
      if (!this._validateId(id)) {
        return res.status(400).json({ success: false, error: 'Invalid session id' });
      }
      const filePath = this._resolveSessionPath(id);
      if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'Session not found' });
      }
      const content = await fs.promises.readFile(filePath, 'utf8');
      const md = this._renderMarkdown(content);

      const safeBase = id.replace(/\.jsonl$/i, '').replace(/[\r\n"\\]/g, '');
      res.setHeader('Content-Disposition', `attachment; filename="${safeBase}.md"`);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(md);
    } catch (err) {
      log.error('Error exporting MD', err);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to export' });
    }
  }

  // ── MD renderer (D-08 structure) ─────────────────────────────────
  _renderMarkdown(jsonlContent) {
    const lines = jsonlContent.split('\n').filter((l) => l.trim());
    const events = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }

    const startEvent = events.find((e) => e.type === 'session_start');
    const endEvent   = [...events].reverse().find((e) => e.type === 'session_end');
    const retroEvents = events.filter((e) => e.type === 'retrospective');
    // Latest non-superseded retrospective.
    let latestRetro = null;
    if (retroEvents.length > 0) {
      const supersededTs = new Set(retroEvents.map((r) => r.supersedes_ts).filter(Boolean));
      const candidates = retroEvents.filter((r) => !supersededTs.has(r.ts));
      latestRetro = candidates.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))[0] || null;
    }

    const out = [];
    const ts = startEvent?.start_ts || '(unknown)';
    out.push(`# Session ${ts}`);
    const meta = [];
    if (endEvent?.duration_s != null)       meta.push(`Duration: ${this._fmtDur(endEvent.duration_s)}`);
    if (endEvent?.utterance_count != null)  meta.push(`Utterances: ${endEvent.utterance_count}`);
    if (meta.length) out.push(meta.join(' | '));
    out.push('');

    if (startEvent?.profile_snapshot) {
      out.push('## Profile snapshot');
      out.push('```');
      out.push(startEvent.profile_snapshot);
      out.push('```');
      out.push('');
    }

    // Group events into Q&A pairs: every 'them' utterance starts a new Q.
    let qIndex = 0;
    let inQuestion = false;
    for (const ev of events) {
      if (ev.type === 'utterance' && ev.speaker === 'them') {
        qIndex += 1;
        inQuestion = true;
        out.push(`## Q${qIndex}`);
        out.push(`> them: ${this._mdEscape(ev.text)}`);
      } else if (ev.type === 'utterance' && ev.speaker === 'me') {
        if (inQuestion) {
          out.push(`> me: ${this._mdEscape(ev.text)}`);
        } else {
          out.push(`### Aside`);
          out.push(`> me: ${this._mdEscape(ev.text)}`);
          out.push('');
        }
      } else if (ev.type === 'ai_answer') {
        const badge = `${ev.provider || 'unknown'} · ${ev.prompt_type || 'interview-answer'}`;
        out.push(`**ai (${badge}):** ${this._mdEscape(ev.text)}`);
        out.push('');
      } else if (ev.type === 'screenshot_qa') {
        qIndex += 1;
        out.push(`## Q${qIndex} (screenshot)`);
        out.push(`> ocr: ${this._mdEscape(ev.ocr_text || '(no OCR text)')}`);
        const badge = `${ev.provider || 'unknown'} · ${ev.prompt_type || 'system'}`;
        out.push(`**ai (${badge}):** ${this._mdEscape(ev.ai_answer || '')}`);
        if (ev.screenshot_path) out.push(`*screenshot: ${ev.screenshot_path}*`);
        out.push('');
        inQuestion = false;
      }
    }

    if (latestRetro) {
      out.push('## Retrospective');
      out.push(`*critiqued at ${latestRetro.ts || '(unknown)'} · ${latestRetro.provider || 'unknown'}*`);
      out.push('');
      out.push(latestRetro.text || '');
      out.push('');
    }

    return out.join('\n');
  }

  _fmtDur(seconds) {
    if (seconds == null) return '—';
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  _mdEscape(text) {
    // Minimal MD-safety: collapse Windows line endings; do NOT escape * or _.
    return String(text || '').replace(/\r\n/g, '\n');
  }

  // ── GET /api/sessions/screenshots/:basename ─────────────────────
  // Serves a single screenshot from the configured screenshots directory with
  // strict basename validation (T-05-04-03 mitigation: regex + path.resolve prefix check).
  async screenshotProxy(req, res) {
    try {
      const { basename } = req.params;
      if (!basename || !SCREENSHOT_BASENAME_REGEX.test(basename)) {
        return res.status(400).json({ success: false, error: 'Invalid screenshot basename' });
      }
      const dir = (aiService.config && aiService.config.screenshots_path) ? aiService.config.screenshots_path : '';
      if (!dir) return res.status(404).json({ success: false, error: 'Screenshots path not configured' });

      const candidate = path.resolve(dir, basename);
      const baseResolved = path.resolve(dir);
      const within = process.platform === 'win32'
        ? candidate.toLowerCase().startsWith(baseResolved.toLowerCase() + path.sep.toLowerCase())
        : candidate.startsWith(baseResolved + path.sep);
      if (!within) return res.status(400).json({ success: false, error: 'Path escape rejected' });
      if (!fs.existsSync(candidate)) return res.status(404).json({ success: false, error: 'Not found' });

      const ext = path.extname(candidate).toLowerCase();
      const ctype = ext === '.png'  ? 'image/png'
                  : ext === '.webp' ? 'image/webp'
                  : 'image/jpeg';
      res.setHeader('Content-Type', ctype);
      res.setHeader('Cache-Control', 'private, max-age=300');
      fs.createReadStream(candidate)
        .on('error', (err) => {
          log.error('Screenshot proxy stream error', { basename, error: err.message });
          if (!res.headersSent) res.status(500).end();
        })
        .pipe(res);
    } catch (err) {
      log.error('Screenshot proxy error', err);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed' });
    }
  }

  // ── POST /api/sessions/:id/retrospective ────────────────────────
  // Streams an AI critique of the session via Socket.IO retrospective_* events
  // (D-13) and appends a {type:"retrospective"} line to the JSONL after the
  // existing session_end footer (D-15). Re-runs set supersedes_ts to the
  // previous latest non-superseded retrospective's ts so readers always pick
  // the newest one.
  async streamRetrospective(req, res) {
    const { id } = req.params;
    if (!this._validateId(id)) {
      return res.status(400).json({ success: false, error: 'Invalid session id' });
    }
    const filePath = this._resolveSessionPath(id);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const requestId = `retro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Build prompt: render the session as transcript, inject {PROFILE} + {TRANSCRIPT}.
    let systemPrompt;
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      const transcript = this._renderTranscriptForRetro(content);
      const profile = aiService.getProfile() || '';
      const template = aiService.readPromptFromFile('retrospective');
      if (!template || template === 'Analyze this screenshot text and provide insights') {
        // readPromptFromFile fallback string — means prompts/retrospective-prompt.txt didn't load
        return res.status(500).json({ success: false, error: 'Retrospective prompt template not loaded' });
      }
      systemPrompt = template
        .replace('{PROFILE}', profile ? `## Candidate Profile\n${profile}\n` : '')
        .replace('{TRANSCRIPT}', transcript);
    } catch (err) {
      log.error('Could not build retrospective prompt', { id, error: err.message });
      return res.status(500).json({ success: false, error: 'Could not build prompt' });
    }

    // Find the latest non-superseded retrospective ts (for supersedes_ts on this run).
    let supersedesTs = null;
    try {
      const c = await fs.promises.readFile(filePath, 'utf8');
      const retros = c.split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e && e.type === 'retrospective');
      if (retros.length > 0) {
        const supSet = new Set(retros.map((r) => r.supersedes_ts).filter(Boolean));
        const latest = retros.filter((r) => !supSet.has(r.ts))
          .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))[0];
        if (latest) supersedesTs = latest.ts || null;
      }
    } catch { /* ignore — no prior retro means supersedesTs stays null */ }

    // Send 200 with requestId immediately; Socket.IO carries the actual stream.
    res.json({ success: true, requestId });

    // Emit started
    if (_retrospectiveBroadcaster) {
      _retrospectiveBroadcaster('retrospective_started', { sessionId: id, requestId });
    }

    // Stream
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: 'Please provide your retrospective critique.' },
    ];

    let fullText = '';
    let finalProvider = 'unknown';
    try {
      for await (const { token, provider } of aiService.callAIWithFallbackStream(messages, { temperature: 0.5, max_tokens: 2048 })) {
        fullText += token;
        if (provider) finalProvider = provider;
        if (_retrospectiveBroadcaster) {
          _retrospectiveBroadcaster('retrospective_token', { token, requestId });
        }
      }
      // Append to JSONL — but only if file still exists (Pitfall 2: user may have deleted it mid-stream).
      if (fs.existsSync(filePath)) {
        const event = {
          type: 'retrospective',
          ts: new Date().toISOString(),
          unix_ts: Math.floor(Date.now() / 1000),
          provider: finalProvider,
          model: null,
          prompt_type: 'retrospective',
          text: fullText,
          supersedes_ts: supersedesTs,
        };
        try {
          await fs.promises.appendFile(filePath, JSON.stringify(event) + '\n');
        } catch (appendErr) {
          log.warn('Could not append retrospective to JSONL', { id, error: appendErr.message });
        }
      } else {
        log.warn('Session file deleted mid-stream; skipping JSONL append', { id });
      }

      if (_retrospectiveBroadcaster) {
        _retrospectiveBroadcaster('retrospective_complete', {
          requestId, response: fullText, provider: finalProvider,
        });
      }
    } catch (err) {
      log.error('Retrospective streaming failed', { id, error: err.message });
      if (_retrospectiveBroadcaster) {
        _retrospectiveBroadcaster('retrospective_error', { requestId, error: err.message });
      }
    }
  }

  // Build the transcript string used as the {TRANSCRIPT} placeholder.
  // Human-dialog-only per GAP-05-05 fix (user feedback 2026-04-16): AI's own
  // answers are NOT useful input for its own self-critique. We ship the retro AI:
  //   - Q{n}:           interviewer utterance (them)
  //   - A{n}:           candidate utterance (me) — n tracks latest Q
  //   - Q{n} (screenshot): OCR-extracted question text from a screenshot Q&A
  // We intentionally drop `ai_answer` events AND the `ai_answer` part of
  // `screenshot_qa` events. The user-facing Markdown export (_renderMarkdown)
  // still includes AI bubbles per D-08 — only the retro prompt narrows.
  _renderTranscriptForRetro(jsonlContent) {
    const events = jsonlContent.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    const out = [];
    let qIndex = 0;
    // inQuestion is kept for parity with _renderMarkdown's grouping logic so
    // future additions (e.g. "Aside" handling) can mirror that method; not
    // currently used to gate output but left for clarity.
    let inQuestion = false;
    for (const ev of events) {
      if (ev.type === 'utterance' && ev.speaker === 'them') {
        qIndex += 1;
        inQuestion = true;
        out.push(`Q${qIndex}: ${this._mdEscape(ev.text)}`);
      } else if (ev.type === 'utterance' && ev.speaker === 'me') {
        out.push(`A${qIndex}: ${this._mdEscape(ev.text)}`);
      } else if (ev.type === 'screenshot_qa') {
        qIndex += 1;
        out.push(`Q${qIndex} (screenshot): ${this._mdEscape(ev.ocr_text || '')}`);
        out.push('');
        inQuestion = false;
      }
      // NOTE: `ai_answer` events intentionally dropped — see header comment.
    }
    return out.join('\n');
  }
}

export default new SessionsController();
