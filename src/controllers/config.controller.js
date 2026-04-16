import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import Groq from 'groq-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import logger from '../utils/logger.js';
import aiService from '../services/ai.service.js';

const log = logger('ConfigController');

const CONFIG_FILE_PATH = path.join(process.cwd(), 'config', 'api-keys.json');
const HOTKEYS_FILE_PATH = path.join(process.cwd(), 'config', 'hotkeys.json');
const PROFILE_FILE_PATH = path.join(process.cwd(), 'config', 'profile.md');
const PROFILE_MAX_BYTES = 65536; // 64 KB hard limit (security: oversized payload DoS). Soft warning at 8 KB lives in UI.

const KNOWN_PROVIDER_LABELS = {
  openai: 'OpenAI',
  grok: 'Grok (Groq)',
  gemini: 'Gemini',
  claude: 'Claude (Anthropic)',
  'claude-subscription': 'Claude Subscription',
};

// Fallback model lists per provider (used when live fetch fails or as initial options)
const FALLBACK_MODELS = {
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
  ],
  grok: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' },
    { id: 'gemma2-9b-it', name: 'Gemma 2 9B' },
    { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B' },
  ],
  gemini: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
    { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
  ],
  claude: [
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
  ],
  'claude-subscription': [
    { id: 'sonnet', name: 'Sonnet (default)' },
    { id: 'opus', name: 'Opus' },
    { id: 'haiku', name: 'Haiku' },
  ],
};

const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  grok: 'llama-3.3-70b-versatile',
  gemini: 'gemini-2.5-flash',
  claude: 'claude-sonnet-4-5',
  'claude-subscription': 'sonnet',
};

// Whitelist of valid hotkey slot IDs — rejects unknown keys in POST payload (D-08, security: prototype pollution guard).
const HOTKEY_SLOTS = [
  'hud_toggle',        // global — HUD show/hide, also Hide-for-share (Phase 2 D-04/D-05)
  'listen_toggle',     // global — start/stop always-on listening
  'screenshot',        // global — capture screen under cursor
  'prev_question',     // window-focused — previous Q&A in history
  'next_question',     // window-focused — next Q&A in history
  'scroll_answer_up',  // window-focused — scroll answer bubble up
  'scroll_answer_down',// window-focused — scroll answer bubble down
];

// Factory defaults (D-13, D-04, D-05). Electron accelerator format (D-16).
const DEFAULT_HOTKEYS = {
  hud_toggle:          'CommandOrControl+Shift+H',
  listen_toggle:       'CommandOrControl+Shift+X',
  screenshot:          'CommandOrControl+Shift+P',
  prev_question:       'CommandOrControl+Left',
  next_question:       'CommandOrControl+Right',
  scroll_answer_up:    'CommandOrControl+Shift+Up',
  scroll_answer_down:  'CommandOrControl+Shift+Down',
};

// Accelerator token grammar — whitelist of allowed tokens (security: reject crafted strings before they reach Electron's globalShortcut).
// Modifiers: CommandOrControl, CmdOrCtrl, Command, Cmd, Control, Ctrl, Shift, Alt, Option, AltGr, Super, Meta.
// Keys: A-Z, 0-9, F1-F24, arrow keys, and a small set of named keys Electron supports.
const HOTKEY_MODIFIER_TOKENS = new Set([
  'CommandOrControl','CmdOrCtrl','Command','Cmd','Control','Ctrl',
  'Shift','Alt','Option','AltGr','Super','Meta',
]);
const HOTKEY_NAMED_KEYS = new Set([
  'Left','Right','Up','Down','Space','Tab','Backspace','Delete','Insert','Home','End','PageUp','PageDown','Escape','Enter','Return',
  'Plus','numadd','numsub','nummult','numdiv','numdec','Capslock','Numlock','Scrolllock','PrintScreen',
]);

// Max payload size for POST body — well under express.json default (100kb) but explicit (security: DOS / oversized payload).
const HOTKEYS_MAX_BYTES = 4096;

// Server-side broadcast hook — dataHandler registers itself here on construction.
// Used so the controller can emit `hotkeys_updated` on /data-updates without a circular import.
let _hotkeyBroadcaster = null;
export function registerHotkeyBroadcaster(fn) { _hotkeyBroadcaster = typeof fn === 'function' ? fn : null; }

class ConfigController {
  getConfigFilePath() {
    const configDir = path.dirname(CONFIG_FILE_PATH);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    return CONFIG_FILE_PATH;
  }

  _readConfig() {
    const configPath = this.getConfigFilePath();
    if (!fs.existsSync(configPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      return null;
    }
  }

  // Read + parse config/hotkeys.json. Returns { hotkeys, warning? }.
  // On missing file OR parse error: returns DEFAULT_HOTKEYS + warning string.
  _readHotkeys() {
    if (!fs.existsSync(HOTKEYS_FILE_PATH)) {
      return { hotkeys: { ...DEFAULT_HOTKEYS }, warning: 'hotkeys.json not found, using defaults' };
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(HOTKEYS_FILE_PATH, 'utf8'));
    } catch (err) {
      return { hotkeys: { ...DEFAULT_HOTKEYS }, warning: 'hotkeys.json unparseable, using defaults' };
    }
    // Merge: unknown slots in the file are ignored; missing slots fall back to defaults.
    const safe = Object.create(null);
    for (const slot of HOTKEY_SLOTS) {
      const v = parsed && typeof parsed[slot] === 'string' ? parsed[slot] : DEFAULT_HOTKEYS[slot];
      safe[slot] = v;
    }
    return { hotkeys: safe };
  }

  // Validate accelerator string token-by-token. Returns null if valid, or error message.
  _validateAccelerator(accel) {
    if (accel === '') return null;  // empty string = slot intentionally cleared (D-06 Backspace)
    if (typeof accel !== 'string') return 'must be a string';
    if (accel.length > 64) return 'too long';
    const parts = accel.split('+');
    if (parts.length === 0) return 'empty accelerator';
    const last = parts[parts.length - 1];
    const modifiers = parts.slice(0, -1);
    for (const m of modifiers) {
      if (!HOTKEY_MODIFIER_TOKENS.has(m)) return `unknown modifier: ${m}`;
    }
    // Final token must be a single printable char (A-Z, 0-9) or a named key.
    if (!(/^[A-Za-z0-9]$/.test(last) || /^F([1-9]|1[0-9]|2[0-4])$/.test(last) || HOTKEY_NAMED_KEYS.has(last))) {
      return `unknown key: ${last}`;
    }
    return null;
  }

  // Detect duplicate accelerators across the seven slots. Returns array of { slot, accel, collidesWith } errors, or [].
  _findHotkeyConflicts(map) {
    const errors = [];
    const seen = new Map();  // accel → first slot that used it
    for (const slot of HOTKEY_SLOTS) {
      const accel = map[slot];
      if (accel === '' || accel == null) continue;  // empty = disabled, doesn't conflict
      if (seen.has(accel)) {
        errors.push({ slot, accel, collidesWith: seen.get(accel) });
      } else {
        seen.set(accel, slot);
      }
    }
    return errors;
  }

  // ── Legacy endpoints (kept for backwards compat) ──────────────────

  getApiKeys(req, res) {
    try {
      const config = this._readConfig();
      if (!config) return res.json({ success: true, config: null });

      const maskedKeys = {};
      if (config.keys) {
        Object.keys(config.keys).forEach((id) => {
          maskedKeys[id] = config.keys[id] ? '***' : '';
        });
      }

      res.json({
        success: true,
        config: {
          keys: maskedKeys,
          order: config.order || [],
          enabled: config.enabled || config.order || [],
        },
      });
    } catch (err) {
      log.error('Error reading API keys config', err);
      res.status(500).json({ success: false, error: 'Failed to read configuration' });
    }
  }

  saveApiKeys(req, res) {
    try {
      const { keys, order, enabled } = req.body;
      if (!order || !Array.isArray(order)) {
        return res.status(400).json({ success: false, error: 'Invalid configuration format' });
      }

      const configPath = this.getConfigFilePath();
      let existingConfig = { keys: {}, order: [], enabled: [] };
      if (fs.existsSync(configPath)) {
        try { existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
      }

      const mergedKeys = { ...existingConfig.keys };
      if (keys) {
        Object.keys(keys).forEach((id) => {
          const newKey = keys[id]?.trim();
          if (newKey && newKey !== '***') mergedKeys[id] = newKey;
        });
      }

      const enabledProviders =
        enabled && Array.isArray(enabled)
          ? enabled
          : order.filter((id) => mergedKeys[id]?.trim());

      if (enabledProviders.length === 0) {
        return res.status(400).json({ success: false, error: 'At least one provider must be enabled' });
      }

      const configToSave = { ...existingConfig, keys: mergedKeys, order, enabled: enabledProviders };
      fs.writeFileSync(configPath, JSON.stringify(configToSave, null, 2), 'utf8');

      const maskedKeys = {};
      Object.keys(configToSave.keys).forEach((id) => {
        maskedKeys[id] = configToSave.keys[id] ? '***' : '';
      });

      res.json({ success: true, message: 'Configuration saved', config: { keys: maskedKeys, order, enabled: enabledProviders } });
    } catch (err) {
      log.error('Error saving API keys config', err);
      res.status(500).json({ success: false, error: 'Failed to save configuration' });
    }
  }

  // ── Full settings read ─────────────────────────────────────────────

  getFullConfig(req, res) {
    try {
      const config = this._readConfig() || { keys: {}, order: [], enabled: [] };

      const allKnownIds = ['openai', 'grok', 'gemini', 'claude', 'claude-subscription'];
      const existingIds = new Set([
        ...(config.order || []),
        ...Object.keys(config.keys || {}).filter(k => k !== 'ollama_model'),
      ]);
      // Merge known providers in; keep existing order, append unknown known ones at end
      const allIds = [...new Set([...allKnownIds, ...existingIds])].filter(id => id !== 'ollama_model');

      // Build ordered list: configured order first, then unordered known providers
      const orderedIds = [
        ...(config.order || []).filter(id => id !== 'ollama_model'),
        ...allIds.filter(id => !(config.order || []).includes(id)),
      ];

      const enabledSet = new Set(config.enabled || config.order || []);
      const providers = orderedIds.map(id => ({
        id,
        label: KNOWN_PROVIDER_LABELS[id] || id,
        hasKey: !!(config.keys?.[id]),
        enabled: enabledSet.has(id),
        model: config.models?.[id] || DEFAULT_MODELS[id] || '',
      }));

      res.json({
        success: true,
        providers,
        stt_model:       config.stt_model       || 'small',
        answer_mode:     config.answer_mode      || 'auto',
        hud_opacity:     config.hud_opacity      ?? 15,
        screenshots_path: config.screenshots_path || '',
        interview_role:  config.interview_role   || '',
      });
    } catch (err) {
      log.error('Error reading full config', err);
      res.status(500).json({ success: false, error: 'Failed to read configuration' });
    }
  }

  // ── Full settings save ─────────────────────────────────────────────

  saveFullConfig(req, res) {
    try {
      const { providers, stt_model, answer_mode, hud_opacity, screenshots_path, interview_role } = req.body;

      const configPath = this.getConfigFilePath();
      let existingConfig = { keys: {}, order: [], enabled: [] };
      if (fs.existsSync(configPath)) {
        try { existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
      }

      // Merge provider keys + models
      const mergedKeys = { ...existingConfig.keys };
      const mergedModels = { ...(existingConfig.models || {}) };
      const order = [];
      const enabledProviders = [];

      if (Array.isArray(providers)) {
        for (const p of providers) {
          if (!p.id) continue;
          order.push(p.id);
          if (p.enabled) enabledProviders.push(p.id);
          // Only update key if a non-blank, non-placeholder value is provided
          if (p.key && p.key.trim() && p.key !== '***') {
            mergedKeys[p.id] = p.key.trim();
          }
          // Save selected model
          if (p.model && p.model.trim()) {
            mergedModels[p.id] = p.model.trim();
          }
        }
      }

      // If claude-subscription was toggled off, remove the 'enabled' sentinel
      // from the stored keys so it does not linger in config/api-keys.json.
      // (For all other providers, empty string means "no change"; this provider
      // uses a non-secret sentinel value instead of a real API key.)
      if (!enabledProviders.includes('claude-subscription') &&
          mergedKeys['claude-subscription'] === 'enabled') {
        delete mergedKeys['claude-subscription'];
      }

      if (enabledProviders.length === 0 && order.length > 0) {
        return res.status(400).json({ success: false, error: 'At least one provider must be enabled' });
      }

      const configToSave = {
        ...existingConfig,           // preserve vad block and any other fields
        keys:             mergedKeys,
        models:           mergedModels,
        order:            order.length ? order : existingConfig.order,
        enabled:          enabledProviders.length ? enabledProviders : existingConfig.enabled,
        stt_model:        stt_model        || existingConfig.stt_model       || 'small',
        answer_mode:      answer_mode      || existingConfig.answer_mode      || 'auto',
        hud_opacity:      hud_opacity      ?? existingConfig.hud_opacity      ?? 15,
        screenshots_path: screenshots_path !== undefined ? screenshots_path : (existingConfig.screenshots_path || ''),
        interview_role:   interview_role   !== undefined ? interview_role   : (existingConfig.interview_role   || ''),
      };

      fs.writeFileSync(configPath, JSON.stringify(configToSave, null, 2), 'utf8');
      log.info('Full config saved', { providers: order, stt_model, answer_mode });

      res.json({ success: true, message: 'Settings saved successfully' });
    } catch (err) {
      log.error('Error saving full config', err);
      res.status(500).json({ success: false, error: 'Failed to save configuration' });
    }
  }

  // ── Hotkeys (Phase 3) ──────────────────────────────────────────────

  // GET /api/config/hotkeys
  getHotkeys(req, res) {
    try {
      const { hotkeys, warning } = this._readHotkeys();
      const payload = { success: true, hotkeys };
      if (warning) payload.warning = warning;
      return res.json(payload);
    } catch (err) {
      log.error('Error reading hotkeys config', err);
      return res.status(500).json({ success: false, error: 'Failed to read hotkeys' });
    }
  }

  // POST /api/config/hotkeys
  // Body: { hotkeys: { hud_toggle: "CommandOrControl+Shift+H", ... } }
  // Response: { success: true, hotkeys } OR { success: false, errors: [{ slot, accel, reason|collidesWith }] }
  saveHotkeys(req, res) {
    try {
      // Payload size check (security: oversized payload DOS).
      const raw = JSON.stringify(req.body || {});
      if (raw.length > HOTKEYS_MAX_BYTES) {
        return res.status(413).json({ success: false, error: 'payload too large' });
      }

      const input = req.body && typeof req.body === 'object' ? req.body.hotkeys : null;
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return res.status(400).json({ success: false, error: 'body.hotkeys must be an object' });
      }

      // Build sanitized map — reject unknown slots (security: prototype pollution, __proto__, etc.).
      const sanitized = Object.create(null);
      const errors = [];
      for (const slot of HOTKEY_SLOTS) {
        const accel = Object.prototype.hasOwnProperty.call(input, slot)
          ? input[slot]
          : DEFAULT_HOTKEYS[slot];
        const parseErr = this._validateAccelerator(accel);
        if (parseErr) {
          errors.push({ slot, accel, reason: parseErr });
        } else {
          sanitized[slot] = accel;
        }
      }
      // Reject unknown slots explicitly — don't silently drop.
      for (const key of Object.keys(input)) {
        if (!HOTKEY_SLOTS.includes(key)) {
          errors.push({ slot: key, reason: 'unknown slot' });
        }
      }
      if (errors.length > 0) {
        return res.status(400).json({ success: false, errors });
      }

      // Internal-conflict detection (HOTK-06, D-08).
      const conflicts = this._findHotkeyConflicts(sanitized);
      if (conflicts.length > 0) {
        return res.status(400).json({ success: false, errors: conflicts });
      }

      // Atomic write: temp file + rename (security: file write race).
      const configPath = HOTKEYS_FILE_PATH;
      const configDir = path.dirname(configPath);
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      const tmpPath = configPath + '.tmp.' + process.pid + '.' + Date.now();
      fs.writeFileSync(tmpPath, JSON.stringify(sanitized, null, 2), 'utf8');
      fs.renameSync(tmpPath, configPath);

      log.info('Hotkeys saved', { slots: HOTKEY_SLOTS.length });

      // Broadcast to /data-updates subscribers (HUD renderer picks this up — see 03-03).
      if (_hotkeyBroadcaster) {
        try { _hotkeyBroadcaster({ hotkeys: sanitized }); }
        catch (err) { log.warn('hotkey broadcast failed', { error: err.message }); }
      }

      return res.json({ success: true, hotkeys: sanitized });
    } catch (err) {
      log.error('Error saving hotkeys config', err);
      return res.status(500).json({ success: false, error: 'Failed to save hotkeys' });
    }
  }

  // ── Profile (Plan 05-02 / SESS-06, SESS-07) ────────────────────────

  // GET /api/profile → { success: true, content: string }
  getProfile(req, res) {
    try {
      let content = '';
      if (fs.existsSync(PROFILE_FILE_PATH)) {
        content = fs.readFileSync(PROFILE_FILE_PATH, 'utf8');
      }
      return res.json({ success: true, content });
    } catch (err) {
      log.error('Error reading profile.md', err);
      return res.status(500).json({ success: false, error: 'Failed to read profile' });
    }
  }

  // POST /api/profile  body: { content: string }
  // Atomic temp+rename write. Refreshes the in-memory cache in ai.service synchronously.
  saveProfile(req, res) {
    try {
      const content = (req.body && typeof req.body.content === 'string') ? req.body.content : '';
      if (Buffer.byteLength(content, 'utf8') > PROFILE_MAX_BYTES) {
        return res.status(413).json({ success: false, error: `Profile exceeds ${PROFILE_MAX_BYTES} bytes` });
      }

      const configDir = path.dirname(PROFILE_FILE_PATH);
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

      // Atomic write — same pattern as saveHotkeys (line 432-434).
      const tmpPath = PROFILE_FILE_PATH + '.tmp.' + process.pid + '.' + Date.now();
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, PROFILE_FILE_PATH);

      // Synchronous cache update so Plan 05-01 session_start sees the new profile immediately
      // (fs.watch debounce is 150ms — would otherwise lose the race for an utterance arriving in that window).
      try { aiService.setProfile(content); } catch (cacheErr) { log.warn('Profile cache refresh failed', { error: cacheErr.message }); }

      log.info('Profile saved', { bytes: Buffer.byteLength(content, 'utf8') });
      return res.json({ success: true });
    } catch (err) {
      log.error('Error saving profile.md', err);
      return res.status(500).json({ success: false, error: 'Failed to save profile' });
    }
  }

  // ── Model list for a provider ──────────────────────────────────────

  async getProviderModels(req, res) {
    const { providerId } = req.params;
    const config = this._readConfig() || {};
    const apiKey = config.keys?.[providerId];

    // Always return fallback list; try live fetch as bonus
    const fallback = FALLBACK_MODELS[providerId] || [];

    if (!apiKey) {
      return res.json({ success: true, models: fallback, source: 'fallback' });
    }

    try {
      let models = [];

      if (providerId === 'openai') {
        const openai = new OpenAI({ apiKey });
        const list = await openai.models.list();
        models = list.data
          .filter(m => m.id.startsWith('gpt-'))
          .sort((a, b) => b.created - a.created)
          .slice(0, 20)
          .map(m => ({ id: m.id, name: m.id }));
      } else if (providerId === 'grok') {
        const groq = new Groq({ apiKey });
        const list = await groq.models.list();
        models = list.data
          .map(m => ({ id: m.id, name: m.id }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } else if (providerId === 'gemini') {
        // Gemini doesn't have a list endpoint in the SDK; return fallback
        models = fallback;
      } else if (providerId === 'claude') {
        // Anthropic doesn't expose a public model list endpoint; return fallback
        models = fallback;
      } else {
        models = fallback;
      }

      if (models.length === 0) models = fallback;
      return res.json({ success: true, models, source: 'live' });
    } catch (err) {
      log.warn(`Could not fetch models for ${providerId}`, { error: err.message });
      return res.json({ success: true, models: fallback, source: 'fallback' });
    }
  }

  // ── Prompt preview ─────────────────────────────────────────────────

  getPromptPreview(req, res) {
    try {
      const { type = 'interview-answer' } = req.query;
      const config = this._readConfig() || {};
      const role = config.interview_role?.trim() || '';

      const PROMPT_FILES = {
        'interview-answer': 'interview-answer-prompt.txt',
        'transcription': 'transcription-prompt.txt',
        'system': 'system-prompt.txt',
      };

      const filename = PROMPT_FILES[type];
      if (!filename) {
        return res.status(400).json({ success: false, error: `Unknown prompt type: ${type}` });
      }

      const promptPath = path.join(process.cwd(), 'prompts', filename);
      let promptText = '';
      try {
        promptText = fs.readFileSync(promptPath, 'utf8').trim();
      } catch {
        return res.status(404).json({ success: false, error: 'Prompt file not found' });
      }

      // Inject role prefix the same way ai.service.js does
      const rolePrefix = role
        ? `## Interview Context\nRole: ${role}\nTailor your answer specifically for a ${role} interview — use relevant tools, frameworks, and terminology for this domain.\n\n`
        : '';

      res.json({
        success: true,
        type,
        role: role || null,
        prompt: rolePrefix + promptText,
      });
    } catch (err) {
      log.error('Error reading prompt preview', err);
      res.status(500).json({ success: false, error: 'Failed to read prompt' });
    }
  }

  // ── Audio devices (proxy to Python transcriber) ────────────────────

  async getAudioDevices(req, res) {
    try {
      const response = await fetch('http://localhost:8000/audio-devices');
      if (!response.ok) {
        const body = await response.text();
        return res
          .status(response.status)
          .type(response.headers.get('content-type') || 'application/json')
          .send(body);
      }
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      log.warn('Transcriber unreachable for GET /audio-devices', { error: err.message });
      return res.status(503).json({
        error: 'Transcriber not reachable',
        detail: err.message,
      });
    }
  }

  async setAudioDevices(req, res) {
    try {
      const response = await fetch('http://localhost:8000/audio-devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
      });
      const body = await response.text();
      return res
        .status(response.status)
        .type(response.headers.get('content-type') || 'application/json')
        .send(body);
    } catch (err) {
      log.warn('Transcriber unreachable for POST /audio-devices', { error: err.message });
      return res.status(503).json({
        error: 'Transcriber not reachable',
        detail: err.message,
      });
    }
  }

  // ── Test provider connection ───────────────────────────────────────

  async testProvider(req, res) {
    const { providerId, key: rawKey } = req.body;
    if (!providerId) {
      return res.status(400).json({ success: false, error: 'providerId is required' });
    }

    // Use stored key if client sent placeholder or no key
    let key = rawKey;
    if (!key || key === '***' || key === '***STORED***') {
      const config = this._readConfig() || {};
      key = config.keys?.[providerId] || '';
    }

    if (!key) {
      return res.status(400).json({ success: false, error: `No API key found for ${providerId}` });
    }

    try {
      if (providerId === 'openai') {
        const openai = new OpenAI({ apiKey: key });
        await openai.models.list();
      } else if (providerId === 'grok') {
        const groq = new Groq({ apiKey: key });
        await groq.models.list();
      } else if (providerId === 'gemini') {
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        await model.generateContent('Hi');
      } else if (providerId === 'claude') {
        const client = new Anthropic({ apiKey: key });
        await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }],
        });
      } else {
        return res.status(400).json({ success: false, error: `Unknown provider: ${providerId}` });
      }

      res.json({ success: true, message: `${KNOWN_PROVIDER_LABELS[providerId] || providerId} connected successfully` });
    } catch (err) {
      log.warn(`Provider test failed: ${providerId}`, { error: err.message });
      res.status(400).json({ success: false, error: err.message });
    }
  }
}

export { DEFAULT_HOTKEYS, HOTKEY_SLOTS };
export default new ConfigController();
