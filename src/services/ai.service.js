import OpenAI from 'openai';
import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

dotenv.config();

const log = logger('AIService');

const CONFIG_FILE_PATH = path.join(process.cwd(), 'config', 'api-keys.json');

const PROMPT_FILE_MAP = {
  system: 'system-prompt.txt',
  context: 'context-prompt.txt',
  transcription: 'transcription-prompt.txt',
  debug: 'debug-prompt.txt',
  coding: 'coding-prompt.txt',
  theory: 'theory-prompt.txt',
  'interview-answer': 'interview-answer-prompt.txt',
};

// Default models per provider (used if not set in config)
const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  grok: 'llama-3.3-70b-versatile',
  gemini: 'gemini-2.5-flash',
  claude: 'claude-sonnet-4-5',
  'claude-subscription': 'sonnet',
};

class AIService {
  constructor() {
    this.config = null;
    this.loadConfig();

    // Track failed providers: { providerId -> { failedAt, failures } }
    this.failedProviders = new Map();

    // Cache for prompt file contents — loaded at startup, refreshed via fs.watch
    this._promptCache = new Map();
    this._loadAllPrompts();

    // Watch config file and prompts directory for changes
    this._watchConfig();
    this._watchPrompts();
  }

  // ==================== Config Management ====================

  loadConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE_PATH)) {
        const configData = fs.readFileSync(CONFIG_FILE_PATH, 'utf8');
        this.config = JSON.parse(configData);
      } else {
        this.config = { keys: {}, order: [], models: {} };
        if (process.env.OPENAI_API_KEY) {
          this.config.keys.openai = process.env.OPENAI_API_KEY;
          this.config.order.push('openai');
        }
        if (process.env.GROQ_API_KEY) {
          this.config.keys.grok = process.env.GROQ_API_KEY;
          this.config.order.push('grok');
        }
        if (process.env.GEMINI_API_KEY) {
          this.config.keys.gemini = process.env.GEMINI_API_KEY;
          this.config.order.push('gemini');
        }
        if (process.env.ANTHROPIC_API_KEY) {
          this.config.keys.claude = process.env.ANTHROPIC_API_KEY;
          this.config.order.push('claude');
        }
      }
    } catch (err) {
      log.error('Error loading AI config', err);
      this.config = { keys: {}, order: [], models: {} };
    }
  }

  _watchConfig() {
    let debounceTimer = null;
    try {
      const dir = path.dirname(CONFIG_FILE_PATH);
      const filename = path.basename(CONFIG_FILE_PATH);
      if (fs.existsSync(dir)) {
        fs.watch(dir, (event, changedFile) => {
          if (changedFile === filename) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              this.loadConfig();
              log.info('Config reloaded due to file change');
            }, 150);
          }
        });
      }
    } catch (err) {
      log.warn('Could not watch config file for changes', { error: err.message });
    }
  }

  // ==================== Model Resolution ====================

  _getModel(providerId) {
    return this.config?.models?.[providerId] || DEFAULT_MODELS[providerId] || undefined;
  }

  // ==================== Prompt Cache ====================

  _loadAllPrompts() {
    const promptsDir = path.join(process.cwd(), 'prompts');
    for (const [type, filename] of Object.entries(PROMPT_FILE_MAP)) {
      try {
        const promptPath = path.join(promptsDir, filename);
        const content = fs.readFileSync(promptPath, 'utf8').trim();
        this._promptCache.set(type, content);
      } catch (err) {
        log.warn(`Could not load prompt file for type: ${type}`);
      }
    }
    log.info(`Prompt cache loaded (${this._promptCache.size} prompts)`);
  }

  _watchPrompts() {
    let debounceTimer = null;
    try {
      const promptsDir = path.join(process.cwd(), 'prompts');
      if (fs.existsSync(promptsDir)) {
        fs.watch(promptsDir, () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            this._loadAllPrompts();
            log.info('Prompt cache refreshed due to file change');
          }, 150);
        });
      }
    } catch (err) {
      log.warn('Could not watch prompts directory', { error: err.message });
    }
  }

  readPromptFromFile(promptType = 'system') {
    const cached = this._promptCache.get(promptType);
    if (cached) return cached;
    log.warn(`Prompt type "${promptType}" not in cache, using default`);
    return 'Analyze this screenshot text and provide insights';
  }

  readContextPromptFromFile(context, promptType = 'context') {
    const cached = this._promptCache.get(promptType);
    if (cached) {
      return cached.replace('{CONTEXT}', context || 'No previous context available');
    }
    log.warn(`Context prompt type "${promptType}" not in cache, using default`);
    return `Previous context:\n${context}\n\nAnalyze this screenshot text and provide insights`;
  }

  readTranscriptionPromptFromFile(promptType = 'transcription') {
    const cached = this._promptCache.get(promptType);
    if (cached) return cached;
    log.warn(`Transcription prompt type "${promptType}" not in cache, using default`);
    return 'Identify the coding interview question from this transcription and provide a complete solution.';
  }

  /**
   * Build role-context prefix if interview_role is configured.
   * Prepended to system prompts so AI tailors answers for that domain.
   */
  _getRolePrefix() {
    const role = this.config?.interview_role?.trim();
    if (!role) return '';
    return `## Interview Context\nRole: ${role}\nTailor your answer specifically for a ${role} interview — use relevant tools, frameworks, and terminology for this domain.\n\n`;
  }

  // ==================== Provider Failure Tracking (exponential backoff) ====================

  _getBackoffMs(failures) {
    return Math.min(30_000 * Math.pow(2, failures - 1), 600_000);
  }

  markProviderAsFailed(providerId) {
    const existing = this.failedProviders.get(providerId);
    const failures = existing ? existing.failures + 1 : 1;
    this.failedProviders.set(providerId, { failedAt: Date.now(), failures });
    const backoffSec = Math.round(this._getBackoffMs(failures) / 1000);
    log.warn(`Marked ${providerId} as failed`, { failures, retryInSec: backoffSec });
  }

  markProviderAsSuccess(providerId) {
    if (this.failedProviders.has(providerId)) {
      this.failedProviders.delete(providerId);
      log.info(`${providerId} recovered — removed from failed list`);
    }
  }

  getAvailableProviders() {
    if (!this.config) return [];

    const enabledProviders = this.config.enabled || [];
    const providersToUse =
      enabledProviders.length > 0
        ? enabledProviders
        : (this.config.order || []).filter((id) => {
            const key = this.config.keys[id];
            return key && key.trim().length > 0;
          });

    const availableProviders = providersToUse.filter((id) => {
      const key = this.config.keys[id];
      return key && key.trim().length > 0;
    });

    const now = Date.now();
    return availableProviders.filter((providerId) => {
      const entry = this.failedProviders.get(providerId);
      if (!entry) return true;

      const { failedAt, failures } = entry;
      const backoff = this._getBackoffMs(failures);
      if (now - failedAt >= backoff) {
        this.failedProviders.delete(providerId);
        log.info(`Retrying ${providerId} after backoff`, {
          failures,
          elapsed: `${Math.round((now - failedAt) / 1000)}s`,
        });
        return true;
      }
      return false;
    });
  }

  // ==================== Non-streaming AI calls ====================

  async callOpenAI(messages, options = {}) {
    const apiKey = this.config?.keys?.openai;
    if (!apiKey) throw new Error('OpenAI API key not configured');
    const openai = new OpenAI({ apiKey });
    const completion = await openai.chat.completions.create({
      model: options.model || this._getModel('openai'),
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 2048,
    });
    return completion.choices[0]?.message?.content || 'No response generated';
  }

  async callGrok(messages, options = {}) {
    const apiKey = this.config?.keys?.grok;
    if (!apiKey) throw new Error('Grok API key not configured');
    const groq = new Groq({ apiKey });
    const completion = await groq.chat.completions.create({
      model: options.model || this._getModel('grok'),
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 2048,
    });
    return completion.choices[0]?.message?.content || 'No response generated';
  }

  async callGemini(messages, options = {}) {
    const apiKey = this.config?.keys?.gemini;
    if (!apiKey) throw new Error('Gemini API key not configured');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: options.model || this._getModel('gemini'),
    });
    const userMessage = messages.find((m) => m.role === 'user')?.content || '';
    const systemMessage = messages.find((m) => m.role === 'system')?.content || '';
    const prompt = systemMessage ? `${systemMessage}\n\n${userMessage}` : userMessage;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text() || 'No response generated';
  }

  async callClaude(messages, options = {}) {
    const apiKey = this.config?.keys?.claude;
    if (!apiKey) throw new Error('Claude API key not configured');
    const client = new Anthropic({ apiKey });

    const systemMsg = messages.find((m) => m.role === 'system')?.content || '';
    const userMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const response = await client.messages.create({
      model: options.model || this._getModel('claude'),
      max_tokens: options.max_tokens || 2048,
      system: systemMsg || undefined,
      messages: userMessages.length > 0 ? userMessages : [{ role: 'user', content: 'Hello' }],
    });
    return response.content[0]?.text || 'No response generated';
  }

  async callClaudeSubscription(messages, options = {}) {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const systemMsg = messages.find((m) => m.role === 'system')?.content || '';
    const userContent = messages
      .filter((m) => m.role !== 'system')
      .map((m) => m.content)
      .join('\n\n');

    const stream = query({
      prompt: userContent || 'Hello',
      options: {
        systemPrompt: systemMsg || undefined,
        model: options.model || this._getModel('claude-subscription') || 'sonnet',
        allowedTools: [],
        maxTurns: 1,
      },
    });

    let result = '';
    for await (const msg of stream) {
      if (msg?.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) result += block.text;
        }
      }
    }
    return result || 'No response generated';
  }

  async callAIWithFallback(messages, options = {}) {
    const providers = this.getAvailableProviders();

    if (providers.length === 0) {
      const allProviders = (
        this.config?.enabled || this.config?.order || []
      ).filter((id) => this.config?.keys?.[id]?.trim());

      if (allProviders.length > 0 && this.failedProviders.size > 0) {
        const now = Date.now();
        const failedList = Array.from(this.failedProviders.entries())
          .map(([id, { failedAt, failures }]) => {
            const backoff = this._getBackoffMs(failures);
            const timeLeft = Math.ceil((backoff - (now - failedAt)) / 1000);
            return `${id} (retry in ${timeLeft}s)`;
          })
          .join(', ');
        throw new Error(`All AI providers temporarily unavailable: ${failedList}`);
      }
      throw new Error('No AI providers configured. Please configure at least one API key.');
    }

    let lastError = null;
    for (const providerId of providers) {
      try {
        log.debug(`Trying AI provider: ${providerId}`);
        let response;
        switch (providerId) {
          case 'openai':              response = await this.callOpenAI(messages, options); break;
          case 'grok':                response = await this.callGrok(messages, options); break;
          case 'gemini':              response = await this.callGemini(messages, options); break;
          case 'claude':              response = await this.callClaude(messages, options); break;
          case 'claude-subscription': response = await this.callClaudeSubscription(messages, options); break;
          default: throw new Error(`Unknown provider: ${providerId}`);
        }
        this.markProviderAsSuccess(providerId);
        log.info(`Success with AI provider: ${providerId}`);
        return { message: { content: response }, provider: providerId };
      } catch (err) {
        log.warn(`${providerId} failed`, { error: err.message });
        this.markProviderAsFailed(providerId);
        lastError = err;
      }
    }

    throw new Error(`All AI providers failed. Last error: ${lastError?.message || 'Unknown error'}`);
  }

  // ==================== Streaming AI calls ====================

  async *streamOpenAI(messages, options = {}) {
    const apiKey = this.config?.keys?.openai;
    if (!apiKey) throw new Error('OpenAI API key not configured');
    const openai = new OpenAI({ apiKey });
    const stream = await openai.chat.completions.create({
      model: options.model || this._getModel('openai'),
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 2048,
      stream: true,
    });
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content || '';
      if (token) yield token;
    }
  }

  async *streamGrok(messages, options = {}) {
    const apiKey = this.config?.keys?.grok;
    if (!apiKey) throw new Error('Grok API key not configured');
    const groq = new Groq({ apiKey });
    const stream = await groq.chat.completions.create({
      model: options.model || this._getModel('grok'),
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 2048,
      stream: true,
    });
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content || '';
      if (token) yield token;
    }
  }

  async *streamGemini(messages, options = {}) {
    const apiKey = this.config?.keys?.gemini;
    if (!apiKey) throw new Error('Gemini API key not configured');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: options.model || this._getModel('gemini'),
    });
    const userMessage = messages.find((m) => m.role === 'user')?.content || '';
    const systemMessage = messages.find((m) => m.role === 'system')?.content || '';
    const prompt = systemMessage ? `${systemMessage}\n\n${userMessage}` : userMessage;
    const result = await model.generateContentStream(prompt);
    for await (const chunk of result.stream) {
      const token = chunk.text() || '';
      if (token) yield token;
    }
  }

  async *streamClaude(messages, options = {}) {
    const apiKey = this.config?.keys?.claude;
    if (!apiKey) throw new Error('Claude API key not configured');
    const client = new Anthropic({ apiKey });

    const systemMsg = messages.find((m) => m.role === 'system')?.content || '';
    const userMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const stream = await client.messages.stream({
      model: options.model || this._getModel('claude'),
      max_tokens: options.max_tokens || 2048,
      system: systemMsg || undefined,
      messages: userMessages.length > 0 ? userMessages : [{ role: 'user', content: 'Hello' }],
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta?.type === 'text_delta' &&
        event.delta.text
      ) {
        yield event.delta.text;
      }
    }
  }

  async *streamClaudeSubscription(messages, options = {}) {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const systemMsg = messages.find((m) => m.role === 'system')?.content || '';
    const userContent = messages
      .filter((m) => m.role !== 'system')
      .map((m) => m.content)
      .join('\n\n');

    const stream = query({
      prompt: userContent || 'Hello',
      options: {
        systemPrompt: systemMsg || undefined,
        model: options.model || this._getModel('claude-subscription') || 'sonnet',
        allowedTools: [],
        maxTurns: 1,
        includePartialMessages: true,
      },
    });

    for await (const msg of stream) {
      if (msg?.type === 'stream_event') {
        const ev = msg.event;
        if (
          ev?.type === 'content_block_delta'
          && ev.delta?.type === 'text_delta'
          && ev.delta.text
        ) {
          yield ev.delta.text;
        }
      }
    }
  }

  /**
   * Streams tokens from the first available provider.
   * Falls back to the next provider if connection fails before any tokens arrive.
   * Yields { token, provider } objects.
   */
  async *callAIWithFallbackStream(messages, options = {}) {
    const providers = this.getAvailableProviders();

    if (providers.length === 0) {
      throw new Error('No AI providers available for streaming.');
    }

    let lastError = null;

    for (const providerId of providers) {
      try {
        let gen;
        switch (providerId) {
          case 'openai':              gen = this.streamOpenAI(messages, options); break;
          case 'grok':                gen = this.streamGrok(messages, options); break;
          case 'gemini':              gen = this.streamGemini(messages, options); break;
          case 'claude':              gen = this.streamClaude(messages, options); break;
          case 'claude-subscription': gen = this.streamClaudeSubscription(messages, options); break;
          default: throw new Error(`Unknown provider: ${providerId}`);
        }

        // Await the first token — surfaces connection/auth errors before we start yielding
        const first = await gen.next();

        this.markProviderAsSuccess(providerId);
        log.info(`Streaming with provider: ${providerId}`);

        if (!first.done && first.value) {
          yield { token: first.value, provider: providerId };
        }

        for await (const token of gen) {
          if (token) yield { token, provider: providerId };
        }

        return;
      } catch (err) {
        log.warn(`${providerId} streaming failed`, { error: err.message });
        this.markProviderAsFailed(providerId);
        lastError = err;
      }
    }

    throw new Error(
      `All AI providers failed for streaming. Last error: ${lastError?.message}`,
    );
  }

  // ==================== High-level API (non-streaming) ====================

  async askGpt(text, promptType = null) {
    const systemPrompt = this.readPromptFromFile(promptType || 'system');
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Screenshot text:\n${text}` },
    ];
    return await this.callAIWithFallback(messages, { temperature: 0.7, max_tokens: 2048 });
  }

  async askGptWithContext(text, previousResponse, promptType = null) {
    const systemPrompt = this.readContextPromptFromFile(previousResponse, promptType || 'context');
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Screenshot text:\n${text}` },
    ];
    return await this.callAIWithFallback(messages, { temperature: 0.7, max_tokens: 2048 });
  }

  async askGptQuestion(question) {
    const prompt = `Answer this technical question clearly and comprehensively.

If the question is about programming:
- Provide code examples when relevant
- Explain concepts clearly
- Offer practical solutions
- Include best practices when applicable

If the question is about concepts or theory:
- Explain with clarity and detail
- Use examples to illustrate points
- Break down complex topics

Question: ${question}`;

    const messages = [
      {
        role: 'system',
        content: 'You are a helpful technical assistant specializing in programming and software development. Provide clear, accurate, and practical answers to technical questions.',
      },
      { role: 'user', content: prompt },
    ];
    return await this.callAIWithFallback(messages, { temperature: 0.7, max_tokens: 2048 });
  }

  async askGptTranscription(transcriptionText, promptType = null) {
    const basePrompt = this.readTranscriptionPromptFromFile(promptType || 'transcription');
    const systemPrompt = this._getRolePrefix() + basePrompt;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Live transcription:\n${transcriptionText}` },
    ];
    return await this.callAIWithFallback(messages, { temperature: 0.7, max_tokens: 2048 });
  }

  // ==================== High-level API (streaming) ====================

  async *askGptStream(text, promptType = null) {
    const systemPrompt = this.readPromptFromFile(promptType || 'system');
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Screenshot text:\n${text}` },
    ];
    yield* this.callAIWithFallbackStream(messages, { temperature: 0.7, max_tokens: 2048 });
  }

  async *askGptTranscriptionStream(transcriptionText, promptType = null) {
    const basePrompt = this.readTranscriptionPromptFromFile(promptType || 'transcription');
    const systemPrompt = this._getRolePrefix() + basePrompt;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Live transcription:\n${transcriptionText}` },
    ];
    yield* this.callAIWithFallbackStream(messages, { temperature: 0.7, max_tokens: 2048 });
  }

  async *askGptWithContextStream(text, previousResponse, promptType = null) {
    const systemPrompt = this.readContextPromptFromFile(previousResponse, promptType || 'context');
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Screenshot text:\n${text}` },
    ];
    yield* this.callAIWithFallbackStream(messages, { temperature: 0.7, max_tokens: 2048 });
  }

  // ==================== Interview Listener ====================

  async _callOllamaClassifier(messages, modelOverride) {
    const model = modelOverride || this.config?.keys?.ollama_model || 'llama3.2:1b';
    const openai = new OpenAI({
      apiKey: 'ollama',
      baseURL: 'http://localhost:11434/v1',
    });
    const completion = await openai.chat.completions.create({
      model,
      messages,
      temperature: 0,
      max_tokens: 256,
      response_format: { type: 'json_object' },
    });
    return completion.choices[0]?.message?.content || '';
  }

  async *_streamOllama(messages, options = {}) {
    const model = options.model || this.config?.keys?.ollama_model || 'llama3.2:1b';
    const openai = new OpenAI({ apiKey: 'ollama', baseURL: 'http://localhost:11434/v1' });
    const stream = await openai.chat.completions.create({
      model,
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 2048,
      stream: true,
    });
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content || '';
      if (token) yield token;
    }
  }

  async summarizeQAPair(question, answer) {
    const model = this.config?.keys?.ollama_model || 'llama3.2:1b';
    const openai = new OpenAI({ apiKey: 'ollama', baseURL: 'http://localhost:11434/v1' });
    const messages = [
      {
        role: 'system',
        content: 'Summarize this interview Q&A into one concise line (max 40 words). Include the topic and key points covered. No bullet points, no preamble — just the summary line.',
      },
      { role: 'user', content: `Q: ${question}\nA: ${answer}` },
    ];
    const completion = await openai.chat.completions.create({
      model,
      messages,
      temperature: 0,
      max_tokens: 100,
    });
    return completion.choices[0]?.message?.content || '';
  }

  async summarizeMerge(entries) {
    const model = this.config?.keys?.ollama_model || 'llama3.2:1b';
    const openai = new OpenAI({ apiKey: 'ollama', baseURL: 'http://localhost:11434/v1' });

    const formatted = entries.map((e, i) => {
      if (e.type === 'merged') return `[${i + 1}] Prior summary: ${e.text}`;
      if (e.summary) return `[${i + 1}] ${e.summary}`;
      return `[${i + 1}] Q: ${e.q}\n    A: ${e.a}`;
    }).join('\n');

    const messages = [
      {
        role: 'system',
        content: 'You are compressing interview conversation history. Merge the following entries into a single concise summary (max 120 words) that preserves topics, key facts, and the chronological flow. No bullet points, no preamble — just the merged summary paragraph.',
      },
      { role: 'user', content: formatted },
    ];
    const completion = await openai.chat.completions.create({
      model,
      messages,
      temperature: 0,
      max_tokens: 250,
    });
    return completion.choices[0]?.message?.content || '';
  }

  setAnswerMode(mode) {
    this._answerMode = mode;
    log.info(`Answer mode set to: ${mode}`);
  }

  async *answerInterviewQuestion(questionText, transcriptContext = '', memoryContext = '') {
    const template = this.readPromptFromFile('interview-answer');
    const rolePrefix = this._getRolePrefix();
    const basePrompt = template
      .replace('{TRANSCRIPT_CONTEXT}', transcriptContext || '(no context yet)')
      .replace('{MEMORY_CONTEXT}', memoryContext ? `## Conversation History\n${memoryContext}` : '');
    const systemPrompt = rolePrefix + basePrompt;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: questionText },
    ];

    const answerMode = this._answerMode || this.config?.answer_mode || 'auto';

    if (answerMode === 'ollama') {
      try {
        for await (const token of this._streamOllama(messages, { temperature: 0.7, max_tokens: 2048 })) {
          yield { token, provider: 'ollama' };
        }
        return;
      } catch (err) {
        log.warn('Ollama answer streaming failed, falling back to remote', { error: err.message });
      }
    } else if (['openai', 'grok', 'gemini', 'claude', 'claude-subscription'].includes(answerMode)) {
      try {
        const opts = { temperature: 0.7, max_tokens: 2048 };
        let gen;
        switch (answerMode) {
          case 'openai':              gen = this.streamOpenAI(messages, opts); break;
          case 'grok':                gen = this.streamGrok(messages, opts); break;
          case 'gemini':              gen = this.streamGemini(messages, opts); break;
          case 'claude':              gen = this.streamClaude(messages, opts); break;
          case 'claude-subscription': gen = this.streamClaudeSubscription(messages, opts); break;
        }
        for await (const token of gen) {
          if (token) yield { token, provider: answerMode };
        }
        return;
      } catch (err) {
        log.warn(`${answerMode} answer streaming failed, falling back`, { error: err.message });
      }
    }

    // 'auto' or fallback
    yield* this.callAIWithFallbackStream(messages, { temperature: 0.7, max_tokens: 2048 });
  }

}

export default new AIService();
