import { logMemory } from '../utils/memory-logger.js';

/**
 * Rolling buffer of recent utterances and conversation memory for AI context.
 * Maintains the last N utterances and a compressed Q&A history.
 */
class InterviewTranscriptBuffer {
  constructor({ maxUtterances = 30, maxMemoryEntries = 5 } = {}) {
    this._utterances = []; // [{ id, text, timestamp }]
    this.maxUtterances = maxUtterances;

    // Conversation memory: rolling window with forever-chain compression.
    // Entries are either:
    //   { type: 'pair',   q, a, summary, summarizing }
    //   { type: 'merged', text, mergedCount }
    this._memory = [];
    this._maxMemoryEntries = maxMemoryEntries;
    this._mergeBatchSize = 3;
    this._merging = false;
    this._summarizeFn = null;   // (q, a) => string
    this._mergeFn = null;       // (entries[]) => string
  }

  /**
   * Inject summarization functions from ai.service.
   * @param {(q: string, a: string) => Promise<string>} summarizeFn
   * @param {(entries: object[]) => Promise<string>} [mergeFn]
   */
  setSummarizeFn(summarizeFn, mergeFn = null) {
    this._summarizeFn = summarizeFn;
    this._mergeFn = mergeFn;
  }

  /**
   * Store a Q&A pair and trigger async summarization.
   * Called right after question_answer_complete.
   */
  addQAPair(question, answer) {
    const entry = { type: 'pair', q: question, a: answer, summary: null, summarizing: false };
    this._memory.push(entry);

    logMemory('qa_pair_added', {
      question: question || '',
      answer: answer || '',
      answer_length: answer?.length || 0,
      memory_size: this._memory.length,
      memory_snapshot: this._snapshot(),
    });

    // Fire-and-forget per-entry summarization (fast token reduction)
    this._summarizeEntry(entry);

    // If over cap, fire-and-forget batch merge of oldest 3 (forever-chain)
    if (this._memory.length > this._maxMemoryEntries) {
      this._mergeOldestAsync();
    }
  }

  _snapshot() {
    return this._memory.map((e) =>
      e.type === 'merged'
        ? { type: 'merged', text: e.text, mergedCount: e.mergedCount }
        : { type: 'pair', q: e.q, a: e.a, summary: e.summary },
    );
  }

  /**
   * Compress oldest 3 entries into one merged summary entry.
   * Non-blocking: placeholder reserves the slot so memory size shrinks
   * immediately; the merged text is filled in once Ollama returns.
   */
  async _mergeOldestAsync() {
    if (this._merging) return; // serialize merges
    if (!this._mergeFn) {
      logMemory('merge_skipped', { reason: 'no_merge_fn' });
      return;
    }
    if (this._memory.length < this._mergeBatchSize) return;

    this._merging = true;
    const batch = this._memory.slice(0, this._mergeBatchSize);
    const placeholder = { type: 'merged', text: '', mergedCount: this._mergeBatchSize, merging: true };
    // Replace the 3 oldest with a single placeholder slot up front
    this._memory.splice(0, this._mergeBatchSize, placeholder);

    const startedAt = Date.now();
    logMemory('merge_start', {
      batch_size: batch.length,
      batch: batch.map((e) =>
        e.type === 'merged'
          ? { type: 'merged', text: e.text }
          : { type: 'pair', q: e.q, a: e.a, summary: e.summary },
      ),
      memory_size_after_reserve: this._memory.length,
    });

    try {
      const merged = await this._mergeFn(batch);
      if (merged && merged.trim()) {
        placeholder.text = merged.trim();
        logMemory('merge_done', {
          duration_ms: Date.now() - startedAt,
          merged_text: placeholder.text,
          merged_length: placeholder.text.length,
          memory_snapshot: this._snapshot(),
        });
      } else {
        // Empty result — restore originals to avoid losing context
        this._memory.splice(this._memory.indexOf(placeholder), 1, ...batch);
        logMemory('merge_empty', { duration_ms: Date.now() - startedAt });
      }
    } catch (err) {
      // On failure, restore originals
      const idx = this._memory.indexOf(placeholder);
      if (idx !== -1) this._memory.splice(idx, 1, ...batch);
      logMemory('merge_error', {
        duration_ms: Date.now() - startedAt,
        error: err?.message || String(err),
      });
    } finally {
      placeholder.merging = false;
      this._merging = false;
    }
  }

  /**
   * Async summarize a single entry. Non-blocking — never delays AI answers.
   * On completion, replaces raw Q&A with compact summary.
   */
  async _summarizeEntry(entry) {
    if (entry.type !== 'pair') return;
    if (!this._summarizeFn) {
      logMemory('summarize_skipped', { reason: 'no_summarize_fn' });
      return;
    }
    entry.summarizing = true;
    const startedAt = Date.now();
    logMemory('summarize_start', { question: entry.q || '', answer: entry.a || '' });
    try {
      const summary = await this._summarizeFn(entry.q, entry.a);
      if (summary && summary.trim()) {
        entry.summary = summary.trim();
        logMemory('summarize_done', {
          duration_ms: Date.now() - startedAt,
          summary: entry.summary,
          summary_length: entry.summary.length,
        });
      } else {
        logMemory('summarize_empty', { duration_ms: Date.now() - startedAt });
      }
    } catch (err) {
      logMemory('summarize_error', {
        duration_ms: Date.now() - startedAt,
        error: err?.message || String(err),
      });
    } finally {
      entry.summarizing = false;
    }
  }

  /**
   * Build memory context string for prompt injection.
   * Uses summary if available, raw Q&A otherwise.
   */
  getMemoryContext() {
    const sections = [];

    if (this._memory.length > 0) {
      const lines = this._memory.map((entry) => {
        if (entry.type === 'merged') {
          if (entry.text) return `- [compressed history of ${entry.mergedCount} entries] ${entry.text}`;
          return `- [compressing ${entry.mergedCount} earlier entries…]`;
        }
        if (entry.summary) return `- ${entry.summary}`;
        return `- Q: ${entry.q}\n  A: ${entry.a}`;
      });
      sections.push(`## Conversation History\n${lines.join('\n')}`);
    }

    if (this._utterances.length > 0) {
      const transcriptLines = this._utterances.map((u) => `- ${u.text}`).join('\n');
      sections.push(`## Recent Transcript (last ${this._utterances.length})\n${transcriptLines}`);
    }

    const out = sections.join('\n\n');
    const usedSummaries = this._memory.filter((e) => e.summary).length;
    logMemory('context_built', {
      entries: this._memory.length,
      used_summaries: usedSummaries,
      used_raw: this._memory.length - usedSummaries,
      utterances: this._utterances.length,
      chars: out.length,
      context: out,
    });
    return out;
  }

  addUtterance(text, role = 'them') {
    const id = `u-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    this._utterances.push({ id, text, role, timestamp: Date.now() });
    if (this._utterances.length > this.maxUtterances) {
      this._utterances.shift();
    }
    return id;
  }

  getTranscriptContext() {
    return this._utterances
      .map((u) => {
        const prefix = u.role === 'me' ? 'Me:' : 'Them:';
        return `${prefix} ${u.text}`;
      })
      .join('\n');
  }

}

export default InterviewTranscriptBuffer;
