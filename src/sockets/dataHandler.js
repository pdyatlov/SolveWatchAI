/**
 * WebSocket handler for /data-updates namespace
 * Handles connection, error, and processing events
 *
 * Two main processing flows:
 * 1. Screenshot Flow:
 *    - Screenshot captured → OCR extraction → AI processing with 'system' prompt
 *    - Generates messageId and stores question/answer
 *
 * 2. Manual Listen Flow (Cmd+Shift+X toggle):
 *    - toggle_listen_mode → POST /start-recording to transcriber
 *    - transcription chunks stream in, forwarded to HUD as transcription_chunk
 *    - toggle_listen_mode off → POST /stop-recording → process_transcription fires
 *    - answerInterviewQuestion() called directly (no classify step)
 *    - Streams tokens to HUD via question_answer_token events
 */
import { EventEmitter } from 'events';
import logger from '../utils/logger.js';
import { logEvent } from '../utils/file-logger.js';
import aiService from '../services/ai.service.js';
import imageProcessingService from '../services/image-processing.service.js';
import InterviewTranscriptBuffer from './InterviewTranscriptBuffer.js';
import { registerHotkeyBroadcaster } from '../controllers/config.controller.js';
import { registerRetrospectiveBroadcaster } from '../controllers/sessions.controller.js';
import sessionRecorder from '../services/session-recorder.service.js';

const log = logger('DataHandler');

// Constants
const VALID_PROMPT_TYPES = ['debug', 'theory', 'coding'];
const DEFAULT_PROMPT_TYPE = 'transcription';
const SCREENSHOT_PROMPT_TYPE = 'system';

// Message data TTL: expire entries older than 30 minutes
const MESSAGE_TTL_MS = 30 * 60 * 1000;
// Cleanup interval: run every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

class DataHandler extends EventEmitter {
  constructor(io) {
    super();
    this.io = io;
    this.namespace = null;
    this.transcriptionChunks = new Map();
    this.selectedPrompts = new Map();
    this.messageData = new Map(); // messageId -> { question, answer, promptType, socketId, timestamp }
    this.pendingPrompts = new Map();
    this.transcriptBuffer = new InterviewTranscriptBuffer();
    this.transcriptBuffer.setSummarizeFn(
      (q, a) => aiService.summarizeQAPair(q, a),
      (entries) => aiService.summarizeMerge(entries),
    );
    this._cleanupTimer = null;
    this.setupNamespace();
    this._startMessageCleanup();
  }

  setupNamespace() {
    this.namespace = this.io.of('/data-updates');
    // Allow config.controller to broadcast hotkey updates on our namespace (Phase 3, 03-01 Task 2C).
    // This closure captures `this` and is registered exactly once per DataHandler instance.
    // Safe because setupNamespace is called once from the constructor and this.namespace is stable thereafter.
    registerHotkeyBroadcaster((payload) => {
      if (this.namespace) {
        this.namespace.emit('hotkeys_updated', payload);
      }
    });
    // Plan 05-05 / D-13: retrospective_* events broadcast to /data-updates.
    registerRetrospectiveBroadcaster((event, payload) => {
      if (this.namespace) {
        this.namespace.emit(event, payload);
      }
    });
    // Plan 05-01 / D-03: provide settings_snapshot for the session_start header.
    sessionRecorder.setSettingsProvider(() => {
      const cfg = aiService.config || {};
      const primary = (cfg.enabled && cfg.enabled[0]) || (cfg.order && cfg.order[0]) || null;
      return {
        provider:    primary,
        model:       cfg.models ? (cfg.models[primary] || null) : null,
        stt_model:   cfg.stt_model   || null,
        answer_mode: aiService._answerMode || cfg.answer_mode || 'auto',
      };
    });
    log.info('Setting up /data-updates namespace');
    this.namespace.on('connection', (socket) => {
      this.handleConnection(socket);
    });
    log.info('Namespace setup complete');
  }

  // ==================== TTL Cleanup ====================

  _startMessageCleanup() {
    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      let removed = 0;
      for (const [id, data] of this.messageData) {
        if (now - data.timestamp > MESSAGE_TTL_MS) {
          this.messageData.delete(id);
          removed++;
        }
      }
      if (removed > 0) {
        log.info(`TTL cleanup: removed ${removed} expired message(s), ${this.messageData.size} remaining`);
      }
    }, CLEANUP_INTERVAL_MS);

    // Don't block process exit
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  // ==================== Connection Handling ====================

  handleConnection(socket) {
    log.info('Client connected', { socketId: socket.id });
    this.emitToSocket(socket, 'connected', {
      socketId: socket.id,
      connectedAt: new Date().toISOString(),
      timestamp: Date.now(),
    });

    socket.on('disconnect', (reason) => this.handleDisconnect(socket, reason));
    socket.on('error', (error) => this.handleError(socket, error));
    socket.on('use_prompt', (data) => this.handleUsePrompt(socket, data));
    socket.on('transcription', (data) => this.handleTranscription(socket, data));
    socket.on('process_transcription', () => this.handleProcessTranscription(socket));
    socket.on('interviewer_speech', (data) => this.handleInterviewerSpeech(socket, data));
    socket.on('toggle_listen_mode', (data) => this.handleToggleListenMode(socket, data));
    socket.on('listen_state_update', (data) => {
      sessionRecorder.onListenStateChanged({ listening: !!data.listening });  // Plan 05-01 / D-01
      this.namespace.emit('listen_state_changed', { listening: !!data.listening });
    });
    socket.on('set_stt_model', (data) => this.handleSetSttModel(socket, data));
    socket.on('set_answer_mode', (data) => this.handleSetAnswerMode(socket, data));
    socket.on('get_settings', () => this.handleGetSettings(socket));
    socket.on('set_hud_opacity', (data) => this.handleSetHudOpacity(data));
    socket.on('set_vad_config', (data) => this.handleSetVadConfig(socket, data));
    socket.on('hotkey_register_failed_relay', (data) => {
      if (this.namespace) this.namespace.emit('hotkey_register_failed', data);
    });
    socket.on('hotkeys_capture_changed', (data) => {
      // Settings page entered/left record mode — rebroadcast so HUD renderer can
      // relay to Electron main and temporarily suspend globalShortcut.
      if (this.namespace) this.namespace.emit('hotkeys_capture_changed', { paused: !!(data && data.paused) });
    });
  }

  handleDisconnect(socket, reason) {
    log.info('Client disconnected', { socketId: socket.id, reason });
    this.cleanupSocketData(socket.id);
    this.emitToSocket(socket, 'connection_status', {
      status: 'disconnected',
      socketId: socket.id,
      reason,
      timestamp: Date.now(),
    });
  }

  cleanupSocketData(socketId) {
    const cleanupActions = [
      { map: this.transcriptionChunks, name: 'transcription chunks' },
      { map: this.selectedPrompts, name: 'selected prompt' },
      { map: this.pendingPrompts, name: 'pending prompt' },
    ];
    cleanupActions.forEach(({ map, name }) => {
      if (map.has(socketId)) {
        map.delete(socketId);
        log.info(`Cleaned up ${name} for disconnected socket`, { socketId });
      }
    });
  }

  handleError(socket, error) {
    const errorMessage = error.message || 'Unknown error';
    log.error('Socket error', { socketId: socket.id, error: errorMessage });
    this.emitToSocket(socket, 'error', {
      socketId: socket.id,
      error: errorMessage,
      timestamp: Date.now(),
    });
  }

  // ==================== use_prompt ====================

  async handleUsePrompt(socket, data) {
    const { promptType, screenshotRequired = false, messageId } = data || {};

    const validationError = this.validateUsePromptInput(socket, promptType, messageId);
    if (validationError) return;

    const messageData = this.messageData.get(messageId);
    if (!messageData) {
      log.warn('Message data not found for messageId', { socketId: socket.id, messageId });
      this.emitToSocket(socket, 'use_prompt_error', {
        error: 'Message data not found for the provided messageId',
        messageId,
      });
      return;
    }

    const { question, answer } = messageData;

    if (screenshotRequired) {
      this.handleScreenshotRequired(socket, { promptType, messageId, question, answer });
      return;
    }

    this.emitToSocket(socket, 'use_prompt_set', {
      promptType,
      messageId,
      screenshotRequired: false,
      message: `Processing with ${promptType} prompt`,
      timestamp: Date.now(),
    });

    await this.processPromptWithQuestion(socket, promptType, messageId, question, answer, null);
  }

  validateUsePromptInput(socket, promptType, messageId) {
    if (!promptType || !VALID_PROMPT_TYPES.includes(promptType)) {
      log.warn('Invalid prompt type received', { socketId: socket.id, promptType });
      this.emitToSocket(socket, 'use_prompt_error', {
        error: `Invalid prompt type. Must be one of: ${VALID_PROMPT_TYPES.join(', ')}`,
        received: promptType,
      });
      return true;
    }
    if (!messageId) {
      log.warn('Missing messageId in use_prompt', { socketId: socket.id });
      this.emitToSocket(socket, 'use_prompt_error', { error: 'messageId is required' });
      return true;
    }
    return false;
  }

  handleScreenshotRequired(socket, { promptType, messageId, question, answer }) {
    log.info('Screenshot required, waiting up to 3s for screenshot', {
      socketId: socket.id,
      messageId,
      promptType,
    });

    const timeoutId = setTimeout(async () => {
      const pending = this.pendingPrompts.get(socket.id);
      if (pending && pending.messageId === messageId) {
        log.info('Screenshot timeout elapsed, processing without screenshot', {
          socketId: socket.id,
          messageId,
          promptType,
        });
        this.pendingPrompts.delete(socket.id);
        this.emitToSocket(socket, 'use_prompt_set', {
          promptType,
          messageId,
          screenshotRequired: false,
          message: `Processing with ${promptType} prompt (no screenshot captured)`,
          timestamp: Date.now(),
        });
        await this.processPromptWithQuestion(socket, promptType, messageId, question, answer, null);
      }
    }, 3000);

    this.pendingPrompts.set(socket.id, {
      promptType,
      messageId,
      screenshotRequired: true,
      question,
      answer,
      timeoutId,
    });

    this.emitToSocket(socket, 'use_prompt_set', {
      promptType,
      messageId,
      screenshotRequired: true,
      message: `Waiting for screenshot to process with ${promptType} prompt`,
      timestamp: Date.now(),
    });
  }

  // ==================== Transcription ====================

  handleTranscription(socket, data) {
    const { textChunk } = data || {};
    if (!textChunk || typeof textChunk !== 'string') {
      log.warn('Invalid transcription chunk received', { socketId: socket.id, data });
      return;
    }
    if (!this.transcriptionChunks.has(socket.id)) {
      this.transcriptionChunks.set(socket.id, []);
    }
    const chunks = this.transcriptionChunks.get(socket.id);
    chunks.push(textChunk);
    log.debug('Transcription chunk received', {
      socketId: socket.id,
      chunkLength: textChunk.length,
      totalChunks: chunks.length,
    });
    // Forward live chunk to HUD for the transcription strip
    this.namespace.emit('transcription_chunk', { text: textChunk });
    logEvent('transcription_chunk_received', 'DEBUG', { module: 'DataHandler', chunkLength: textChunk.length });
  }

  /**
   * Processes accumulated transcription chunks as an interview question.
   * Called when the user stops recording (toggle_listen_mode off → Python fires process_transcription).
   * Answers directly — no AI classification step.
   */
  async handleProcessTranscription(socket) {
    const chunks = this.transcriptionChunks.get(socket.id);

    if (!chunks || chunks.length === 0) {
      log.warn('No transcription chunks found for processing', { socketId: socket.id });
      return;
    }

    const fullTranscription = chunks.join(' ').trim();
    this.transcriptionChunks.delete(socket.id);

    if (!fullTranscription) return;

    await this._answerInterviewQuestionFromText(socket, fullTranscription, 'manual');
  }

  /**
   * Handles a VAD-segmented utterance from the always-on listener.
   * Unlike handleProcessTranscription, the text here is already complete —
   * Python's AlwaysOnListener has done silence detection + transcription,
   * so we emit it to the HUD for live display and trigger the Q&A pipeline
   * immediately without chunk accumulation.
   */
  async handleInterviewerSpeech(socket, data) {
    const text = (data?.text || '').trim();
    if (!text) {
      log.warn('Empty interviewer_speech received', { socketId: socket.id });
      return;
    }
    const source = data?.source === 'me' ? 'me' : 'them';

    // Forward to HUD with source so the chat strip knows which side to render.
    this.namespace.emit('transcription_chunk', { text, source });
    logEvent('transcription_chunk_received', 'DEBUG', {
      module: 'DataHandler',
      chunkLength: text.length,
      source,
    });

    // Persist to session JSONL (Plan 05-01 / SESS-01, SESS-02). 'me' utterances persist too (D-02).
    sessionRecorder.recordUtterance({ speaker: source, text });

    if (source === 'me') {
      // Display + add to transcript buffer as context. No AI trigger.
      this.transcriptBuffer.addUtterance(text, 'me');
      return;
    }

    // source === 'them': run the existing Q&A pipeline.
    await this._answerInterviewQuestionFromText(socket, text, 'always_on');
  }

  /**
   * Shared Q&A pipeline: given a complete interviewer utterance, streams an
   * AI answer to the HUD and stores message data keyed by questionId so the
   * Debug/Theory/Coding buttons can re-prompt on it.
   */
  async _answerInterviewQuestionFromText(socket, fullTranscription, origin) {
    const questionId = `q-${Date.now()}`;
    const transcriptContext = this.transcriptBuffer.getTranscriptContext();
    const memoryContext = this.transcriptBuffer.getMemoryContext();

    this.transcriptBuffer.addUtterance(fullTranscription, 'them');

    log.info('Processing interviewer utterance', {
      socketId: socket.id,
      questionId,
      origin,
      transcriptionLength: fullTranscription.length,
    });

    this.namespace.emit('interviewer_question', { questionId, questionText: fullTranscription });
    this.namespace.emit('question_answer_started', { questionId });

    let fullResponse = '';
    let answerProvider = 'unknown';
    try {
      for await (const { token, provider } of aiService.answerInterviewQuestion(fullTranscription, transcriptContext, memoryContext)) {
        fullResponse += token;
        if (provider) answerProvider = provider;
        this.namespace.emit('question_answer_token', { token, questionId });
      }

      this.storeMessageData(
        questionId,
        fullTranscription,
        fullResponse,
        'interview-answer',
        socket.id,
      );

      this.namespace.emit('question_answer_complete', {
        questionId,
        response: fullResponse,
        messageId: questionId,
      });
      // Persist AI answer to session JSONL (Plan 05-01 / SESS-02).
      // question_ref ties this answer back to the originating them utterance via questionId.
      sessionRecorder.recordAiAnswer({
        text: fullResponse,
        provider: answerProvider,
        model: null,                             // model isn't surfaced by answerInterviewQuestion; null acceptable
        promptType: 'interview-answer',
        questionRef: questionId,
      });
      log.info('Interviewer utterance answered', { questionId, origin, responseLength: fullResponse.length });
      logEvent('interviewer_question_answered', 'INFO', { module: 'DataHandler', questionId, origin, responseLength: fullResponse.length });

      if (fullTranscription && fullResponse) {
        this.transcriptBuffer.addQAPair(fullTranscription, fullResponse);
      }
    } catch (err) {
      log.error('Error answering interviewer utterance', { questionId, origin, error: err.message });
      this.namespace.emit('question_answer_complete', { questionId, response: 'Error generating answer.' });
    }
  }

  /**
   * Processes a prompt with streaming AI.
   * Emits ai_token to the requesting socket, ai_processing_complete to the namespace.
   */
  async processPromptWithQuestion(
    socket,
    promptType,
    sourceMessageId,
    question,
    answer,
    screenshotText,
  ) {
    try {
      const socketId = socket?.id || 'unknown';
      log.info('Processing prompt with question', {
        socketId,
        promptType,
        sourceMessageId,
        hasScreenshotText: !!screenshotText,
      });

      const promptText = this.buildPromptText(promptType, question, answer, screenshotText);
      const messageId = this.generateMessageId();

      this.emitAIStarted('prompt', question, false);

      const aiStartTime = Date.now();
      let fullResponse = '';
      let provider = 'unknown';

      for await (const { token, provider: p } of aiService.askGptStream(promptText, promptType)) {
        fullResponse += token;
        provider = p;
        this.emitToSocket(socket, 'ai_token', { token, messageId });
      }

      const aiDuration = Date.now() - aiStartTime;

      this.storeMessageData(messageId, question, fullResponse, promptType, socketId);

      log.info('Prompt processing completed', {
        socketId,
        sourceMessageId,
        newMessageId: messageId,
        promptType,
        provider,
        aiDuration: `${aiDuration}ms`,
        responseLength: fullResponse.length,
      });

      this.emitAIComplete('prompt', fullResponse, provider, aiDuration, false, messageId);
    } catch (err) {
      log.error('Error processing prompt with question', {
        socketId: socket?.id || 'unknown',
        sourceMessageId,
        promptType,
        error: err.message,
        stack: err.stack,
      });
      this.emitProcessingError('prompt', 'prompt', err);
    }
  }

  buildPromptText(promptType, question, answer, screenshotText) {
    switch (promptType) {
      case 'debug': {
        let promptText = `Question: ${question}\n\nAnswer: ${answer}`;
        if (screenshotText) promptText += `\n\nScreenshot text:\n${screenshotText}`;
        return promptText;
      }
      case 'theory':
      case 'coding':
        return question;
      default:
        throw new Error(`Unknown prompt type: ${promptType}`);
    }
  }

  generateMessageId() {
    return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // ==================== Message Data Management ====================

  storeMessageData(messageId, question, answer, promptType, socketId) {
    this.messageData.set(messageId, {
      question,
      answer,
      promptType,
      socketId,
      timestamp: Date.now(),
    });
    log.info('Message data stored', {
      messageId,
      questionLength: question?.length || 0,
      answerLength: answer?.length || 0,
      promptType,
      socketId,
    });
  }

  getMessageData(messageId) {
    return this.messageData.get(messageId) || null;
  }

  getPendingPrompt(socketId) {
    return this.pendingPrompts.get(socketId) || null;
  }

  clearPendingPrompt(socketId) {
    const pending = this.pendingPrompts.get(socketId);
    if (pending?.timeoutId) clearTimeout(pending.timeoutId);
    this.pendingPrompts.delete(socketId);
  }

  getSelectedPromptType() {
    if (this.selectedPrompts.size === 0) return null;
    return this.selectedPrompts.values().next().value;
  }

  // ==================== Emit Helpers ====================

  emitToSocket(socket, event, data) {
    if (socket && socket.emit) socket.emit(event, data);
  }

  emitScreenshotCaptured(filename, filePath) {
    if (!this.namespace) return;
    log.info('Screenshot captured', { filename });
    this.namespace.emit('screenshot_captured', {
      message: `Screenshot captured: ${filename}`,
    });
  }

  emitOCRStarted(filename, filePath) {
    if (!this.namespace) return;
    log.info('OCR started');
    this.namespace.emit('ocr_started', { message: 'OCR started' });
  }

  emitOCRComplete(filename, extractedText, duration) {
    if (!this.namespace) return;
    log.info('OCR completed', { extractedTextLength: extractedText?.length });
    this.namespace.emit('ocr_complete', { message: 'OCR completed' });
  }

  emitAIStarted(filename, extractedText, useContext) {
    if (!this.namespace) return;
    log.info('AI processing started');
    this.namespace.emit('ai_processing_started', { message: 'AI processing started' });
  }

  emitAIComplete(filename, response, provider, duration, useContext, messageId = null) {
    if (!this.namespace) return;
    log.info('AI processing completed', { messageId, responseLength: response?.length });
    const eventData = { response, message: 'AI processing completed' };
    if (messageId) eventData.messageId = messageId;
    this.namespace.emit('ai_processing_complete', eventData);
  }

  emitProcessingError(filename, stage, error) {
    if (!this.namespace) return;
    const errorMessage = error.message || 'Unknown error';
    log.error(`Error during ${stage} processing`, { error: errorMessage });
    this.namespace.emit('aiprocessing_error', {
      error: errorMessage,
      message: `Error during ${stage} processing`,
    });
  }

  // ==================== Manual Listen Mode ====================

  async handleToggleListenMode(socket, data) {
    const { enabled } = data || {};
    try {
      await fetch('http://localhost:8000/always-on-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !!enabled }),
      });
      log.info('Listen mode toggled', { enabled });
      logEvent(enabled ? 'listen_started' : 'listen_stopped', 'INFO', { module: 'DataHandler' });
      sessionRecorder.onListenStateChanged({ listening: !!enabled });  // Plan 05-01 / D-01
      this.namespace.emit('listen_state_changed', { listening: !!enabled });
    } catch (err) {
      log.warn('Could not reach Python transcriber to toggle listen mode', { error: err.message });
      // Revert button state on failure
      this.namespace.emit('listen_state_changed', { listening: !enabled });
    }
  }

  // ==================== Settings ====================

  async handleSetSttModel(socket, data) {
    const { model } = data || {};
    if (!model) return;
    try {
      const res = await fetch('http://localhost:8000/set-stt-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        this.emitToSocket(socket, 'settings_error', { error: body.detail || 'Failed to set STT model' });
        return;
      }
      log.info('STT model changed', { model });
      logEvent('stt_model_changed', 'INFO', { module: 'DataHandler', model });
      this.emitToSocket(socket, 'stt_model_updated', { model });
    } catch (err) {
      log.warn('Could not reach Python transcriber to set STT model', { error: err.message });
      this.emitToSocket(socket, 'settings_error', { error: 'Python transcriber unreachable' });
    }
  }

  handleSetAnswerMode(socket, data) {
    const { mode } = data || {};
    if (!mode) return;
    aiService.setAnswerMode(mode);
    log.info('Answer mode changed', { mode });
    logEvent('answer_mode_changed', 'INFO', { module: 'DataHandler', mode });
    this.emitToSocket(socket, 'answer_mode_updated', { mode });
  }

  async handleGetSettings(socket) {
    let sttModel = 'small';
    try {
      const res = await fetch('http://localhost:8000/settings');
      if (res.ok) {
        const body = await res.json();
        sttModel = body.stt_model || 'small';
      }
    } catch (_) {
      // transcriber may not be running; return defaults
    }
    const answerMode = aiService._answerMode || aiService.config?.answer_mode || 'auto';
    const enabledProviders = aiService.config?.enabled || aiService.config?.order || [];
    this.emitToSocket(socket, 'settings_state', { sttModel, answerMode, enabledProviders });
  }

  async handleSetVadConfig(socket, data) {
    if (!data || typeof data !== 'object') return;
    try {
      const res = await fetch('http://localhost:8000/set-vad-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        this.emitToSocket(socket, 'settings_error', { error: body.detail || 'Failed to update VAD config' });
        return;
      }
      log.info('VAD config updated', data);
      logEvent('vad_config_changed', 'INFO', { module: 'DataHandler', config: data });
      this.emitToSocket(socket, 'vad_config_updated', data);
    } catch (err) {
      log.warn('Could not reach Python transcriber to set VAD config', { error: err.message });
      this.emitToSocket(socket, 'settings_error', { error: 'Python transcriber unreachable' });
    }
  }

  handleSetHudOpacity(data) {
    const value = (typeof data === 'object' && data !== null) ? data.value : data;
    if (value === undefined || value === null) return;
    const clamped = Math.max(0, Math.min(100, parseInt(value) || 0));
    log.info('HUD opacity changed', { value: clamped });
    logEvent('hud_opacity_changed', 'INFO', { module: 'DataHandler', value: clamped });
    // Broadcast to all clients (HUD will pick this up)
    if (this.namespace) {
      this.namespace.emit('hud_opacity_updated', { value: clamped });
    }
  }
}

export default DataHandler;
