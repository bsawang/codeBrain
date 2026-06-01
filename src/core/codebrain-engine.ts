import { ErrorEvent, ErrorKnowledge, MatchResult, FixInfo, PendingError } from './types';
import { MemoryIndex } from './memory-index';
import { MatchEngine } from './match-engine';
import { AIAnalyzer } from './ai-analyzer';
import { StorageEngine } from '../storage/storage-engine';
import { EmbeddingProvider } from '../providers/embedding-provider';
import { LLMProvider } from '../providers/llm-provider';
import { preprocess } from './preprocessor';
import { logger } from '../logger.js';

const ANTI_LOOP_WINDOW = 50;
const ANTI_LOOP_THRESHOLD = 5;

async function withRetry<T>(label: string, fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      else throw e;
    }
  }
  throw new Error('unreachable');
}

function extractCommandPrefix(command?: string): string | undefined {
  if (!command) return undefined;
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(/\s+/);
  const head = parts[0].toLowerCase();
  if (head === 'npx' && parts.length > 1) return `npx:${parts[1].toLowerCase()}`;
  return head;
}

interface InjectionRecord { groupId: string; turnIndex: number; suppressed: boolean; }

function hashGroupId(normalized: string): string {
  let h = 0;
  for (let i = 0; i < normalized.length; i++) h = ((h << 5) - h + normalized.charCodeAt(i)) | 0;
  return `other-${Math.abs(h).toString(36)}`;
}

export class CodeBrainEngine {
  private index: MemoryIndex;
  private matcher: MatchEngine;
  private analyzer: AIAnalyzer;
  private storage: StorageEngine;
  private embedding: EmbeddingProvider;
  private pendingQueue: PendingError[] = [];
  private injectionHistory: InjectionRecord[] = [];
  private turnCounter = 0;
  private extractingPromises = new Map<string, Promise<void>>();
  private pendingFlush: Promise<void>[] = [];

  /** 追踪一个异步任务，供 flush() 等待 */
  private trackFlush(task: Promise<void>): void {
    this.pendingFlush.push(task);
    task.finally(() => {
      const i = this.pendingFlush.indexOf(task);
      if (i >= 0) this.pendingFlush.splice(i, 1);
    });
  }

  /** 等待所有进行中的异步操作完成（主要用于测试 / 批量验证） */
  async flush(): Promise<void> {
    const tasks = [...this.extractingPromises.values(), ...this.pendingFlush];
    if (tasks.length) await Promise.all(tasks);
  }

  constructor(embedding: EmbeddingProvider, llm: LLMProvider, storage: StorageEngine) {
    this.embedding = embedding; this.index = storage.getIndex();
    this.matcher = new MatchEngine(embedding, llm); this.analyzer = new AIAnalyzer(llm);
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.initialize(); this.index = this.storage.getIndex();
    logger.info('engine', `initialized groups=${this.index.size}`);
  }

  async onError(event: ErrorEvent): Promise<string | null> {
    this.injectionHistory = this.injectionHistory.filter(
      (r) => this.turnCounter - r.turnIndex < ANTI_LOOP_WINDOW,
    );
    const match = await this.matcher.matchSync(event, this.index);
    if (!match) {
      this.pendingQueue.push({ normalized: event.normalized, sourceFile: event.sourceFile, errorCode: event.errorCode, command: event.command, timestamp: event.timestamp });
      return null;
    }

    const groupHits = this.injectionHistory.filter((r) => r.groupId === match.groupId && !r.suppressed).length;
    this.injectionHistory.push({ groupId: match.groupId, turnIndex: this.turnCounter, suppressed: false });

    if (groupHits >= ANTI_LOOP_THRESHOLD - 1) {
      logger.warn('engine', `anti-loop: suppress ${match.groupId}`);
      this.injectionHistory = this.injectionHistory.filter((r) => r.groupId !== match.groupId);
      return null;
    }

    if (match.matched.isTrivial) {
      this.pendingQueue.push({ normalized: event.normalized, sourceFile: event.sourceFile, errorCode: event.errorCode, command: event.command, timestamp: event.timestamp, groupId: match.groupId });
      return null;
    }

    this.pendingQueue.push({ normalized: event.normalized, sourceFile: event.sourceFile, errorCode: event.errorCode, command: event.command, timestamp: event.timestamp, groupId: match.groupId });
    return this.formatInjection(match, groupHits >= 1);
  }

  async onSuccess(command: string, exitCode: number): Promise<void> {
    this.turnCounter++;
    if (exitCode !== 0) return;
    const resolved = [...this.pendingQueue]; this.pendingQueue = [];
    for (const pending of resolved) {
      if (pending.groupId) {
        this.incrementVerifiedCount(pending.groupId, command, exitCode);
      } else {
        const ev = { normalized: pending.normalized, errorCode: pending.errorCode, raw: '', timestamp: pending.timestamp, command: pending.command || command, sourceFile: pending.sourceFile };
        this.stage2ExtractSolution(ev, { error: ev, fixTimestamp: Date.now() });
      }
    }
  }

  async onFixDetected(fix: FixInfo): Promise<void> {
    this.pendingQueue = this.pendingQueue.filter((p) => p.normalized !== fix.error.normalized);
    this.stage2ExtractSolution(fix.error, fix);
  }

  private async stage2ExtractSolution(event: ErrorEvent, fix: FixInfo): Promise<void> {
    const dedupKey = event.normalized + (event.sourceFile || '');
    if (this.extractingPromises.has(dedupKey)) return;
    const task = this.#doExtractSolution(event, fix, dedupKey);
    this.extractingPromises.set(dedupKey, task);
    try { await task; } finally { this.extractingPromises.delete(dedupKey); }
  }

  async #doExtractSolution(event: ErrorEvent, fix: FixInfo, dedupKey: string): Promise<void> {
    try {
      const merged = await withRetry('extractSolution', () => this.analyzer.extractSolution(event, fix));

      const groupId = (merged.groupId as string) || hashGroupId(event.normalized);
      const summary = (merged.groupSummary as string) || 'Pending classification';
      const template = merged.errorTemplate ? preprocess(merged.errorTemplate as string) : event.normalized;
      const category = (merged.category as string) || 'other';
      const isTrivial = merged.isTrivial === true;

      let existing = this.index.get(groupId);
      const hasRule = 'abstractRule' in merged && typeof merged.abstractRule === 'string';

      if (hasRule) {
        if (existing) {
          existing.abstractRule = merged.abstractRule as string;
          existing.triggerDescription = merged.triggerDescription as string;
          existing.preventionAdvice = merged.preventionAdvice as string;
          existing.occurrences++; existing.lastSeen = Date.now();
          if (isTrivial) existing.isTrivial = true;
          if (fix.diff) existing.isRote = true;
        } else {
          existing = {
            groupId, summary, errorTemplate: template, occurrences: 1,
            firstSeen: Date.now(), lastSeen: Date.now(), solutions: [], status: 'active',
            abstractRule: merged.abstractRule as string,
            triggerDescription: merged.triggerDescription as string,
            preventionAdvice: merged.preventionAdvice as string,
            isRote: true, isTrivial,
            commandPrefix: extractCommandPrefix(event.command),
            dependencyVersions: event.dependencies,
            category, isProjectSpecific: false, tags: [], relatedGroupIds: [],
          };
        }
      } else {
        const ext = merged as unknown as import('./types').SolutionExtraction;
        const newSol: import('./types').Solution = {
          id: `sol-${Date.now().toString(36)}`, strategy: ext.strategy,
          rootCause: ext.rootCause, avoidanceHint: ext.avoidanceHint, diff: fix.diff,
          verifiedCount: 1, suppressed: false,
          executionTrace: { exitCode: 0, command: event.command || 'unknown', timestamp: Date.now() },
        };

        if (existing) {
          const similar = existing.solutions.find((s) => s.strategy === ext.strategy && s.rootCause === ext.rootCause);
          if (similar) similar.verifiedCount++; else existing.solutions.push(newSol);
          existing.occurrences++; existing.lastSeen = Date.now();
          existing.solutions.sort((a, b) => b.verifiedCount - a.verifiedCount);
          if (!existing.commandPrefix) existing.commandPrefix = extractCommandPrefix(event.command);
          if (isTrivial) existing.isTrivial = true;
        } else {
          existing = {
            groupId, summary, errorTemplate: template, occurrences: 1,
            firstSeen: Date.now(), lastSeen: Date.now(), solutions: [newSol], status: 'active',
            isTrivial,
            commandPrefix: extractCommandPrefix(event.command),
            dependencyVersions: event.dependencies,
            category, isProjectSpecific: false, tags: [], relatedGroupIds: [],
          };
        }
      }

      try { existing.embedding = await this.embedding.embed(event.normalized); } catch {}
      await this.storage.upsert(existing);
      this.index.addTextKey(existing.groupId, event.normalized);

      const validSolutions = existing.solutions.filter((s) => s.strategy && s.rootCause);
      const totalVerified = validSolutions.reduce((sum, s) => sum + s.verifiedCount, 0);
      if (totalVerified >= 3 && !existing.abstractRule) {
        this.#doInduceRule(existing.groupId);
      }
    } catch (e) { logger.error('engine', `extractSolution failed`); }
  }

  async #doInduceRule(groupId: string): Promise<void> {
    try {
      const knowledge = this.index.get(groupId);
      if (!knowledge || knowledge.abstractRule) return;
      const solutions = knowledge.solutions.filter((s) => s.strategy && s.rootCause);
      if (solutions.length === 0) return;
      const totalVerified = solutions.reduce((sum, s) => sum + s.verifiedCount, 0);
      if (totalVerified < 3) return;
      const rule = await withRetry('induceRule', () =>
        this.analyzer.induceRule(knowledge.summary, solutions.map((s) => ({
          error: { normalized: knowledge.errorTemplate, raw: '', timestamp: knowledge.firstSeen, errorCode: undefined } as ErrorEvent,
          solution: { strategy: s.strategy, rootCause: s.rootCause, avoidanceHint: s.avoidanceHint },
        }))),
      );
      knowledge.abstractRule = rule.abstractRule;
      knowledge.triggerDescription = rule.triggerDescription;
      knowledge.preventionAdvice = rule.preventionAdvice;
      knowledge.isRote = true;
      logger.info('engine', `rote: ${groupId}`);
      await this.storage.upsert(knowledge);
    } catch (e) { logger.error('engine', `induceRule failed`); }
  }

  private suppressGroup(groupId: string): void {
    const knowledge = this.index.get(groupId);
    if (!knowledge) return;
    for (const s of knowledge.solutions) {
      s.suppressed = true;
    }
  }

  private incrementVerifiedCount(groupId: string, command: string, exitCode: number): void {
    const knowledge = this.index.get(groupId);
    if (!knowledge) return;
    const top = knowledge.solutions[0];
    if (top) { top.verifiedCount++; top.suppressed = false; }
    knowledge.occurrences++; knowledge.lastSeen = Date.now();
    this.storage.upsert(knowledge);
    if (knowledge.isRote) return;
    if (knowledge.abstractRule) return;
    const solutions = knowledge.solutions.filter((s) => s.strategy && s.rootCause);
    const totalVerified = solutions.reduce((sum, s) => sum + s.verifiedCount, 0);
    if (totalVerified >= 3) this.trackFlush(this.#doInduceRule(groupId));
  }

  private formatInjection(match: MatchResult, warning: boolean): string {
    const k = match.matched;
    const lines: string[] = [ `[codebrain]` ];
    if (k.abstractRule) {
      lines.push(`规则: ${k.abstractRule}`);
      if (k.triggerDescription) lines.push(`触发: ${k.triggerDescription}`);
      lines.push(`验证: ${k.occurrences}次`);
    } else {
      const top = k.solutions[0];
      if (!top) return '';
      lines.push(`fix: ${top.strategy}`, `root: ${top.rootCause}`, `avoid: ${top.avoidanceHint}`);
      lines.push(`hit: ${k.occurrences}次`);
    }
    if (warning) lines.push('上次未解决');
    return lines.join('\n');
  }

  get stats(): Promise<import('./types').StorageStats> { return this.storage.stats(); }
  get knowledge(): MemoryIndex { return this.index; }
}
