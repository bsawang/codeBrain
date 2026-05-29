import { ErrorEvent, ErrorKnowledge, MatchResult, FixInfo, PendingError, GroupingResult } from './types';
import { MemoryIndex } from './memory-index';
import { MatchEngine } from './match-engine';
import { AIAnalyzer } from './ai-analyzer';
import { StorageEngine } from '../storage/storage-engine';
import { EmbeddingProvider } from '../providers/embedding-provider';
import { LLMProvider } from '../providers/llm-provider';

const ANTI_LOOP_WINDOW = 50; // 窗口内轮次
const ANTI_LOOP_THRESHOLD = 3; // 连续命中 3 次抑制

interface InjectionRecord {
  groupId: string;
  turnIndex: number;
  suppressed: boolean;
}

function hashGroupId(normalized: string): string {
  // 简单 hash，同一 normalized 文本始终生成相同 ID
  let h = 0;
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) - h + normalized.charCodeAt(i)) | 0;
  }
  return `grp-${Math.abs(h).toString(36)}`;
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

  constructor(
    embedding: EmbeddingProvider,
    llm: LLMProvider,
    storage: StorageEngine,
  ) {
    this.embedding = embedding;
    this.index = storage.getIndex();
    this.matcher = new MatchEngine(embedding, llm);
    this.analyzer = new AIAnalyzer(llm);
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
    this.index = this.storage.getIndex();
  }

  // ---- 快路径：错误发生时调用（同步） ----

  async onError(event: ErrorEvent): Promise<string | null> {
    // 防循环检查：清理窗口外记录
    this.injectionHistory = this.injectionHistory.filter(
      (r) => this.turnCounter - r.turnIndex < ANTI_LOOP_WINDOW,
    );

    const match = await this.matcher.matchSync(event, this.index);

    if (!match) {
      // 未命中 → 入待处理队列
      this.pendingQueue.push({
        normalized: event.normalized,
        sourceFile: event.sourceFile,
        errorCode: event.errorCode,
        timestamp: event.timestamp,
      });
      // 触发异步阶段1
      this.stage1Group(event).catch(() => {});
      return null;
    }

    // 命中 → 防循环判定
    const groupHits = this.injectionHistory.filter(
      (r) => r.groupId === match.groupId && !r.suppressed,
    ).length;

    this.injectionHistory.push({
      groupId: match.groupId,
      turnIndex: this.turnCounter,
      suppressed: false,
    });

    if (groupHits >= ANTI_LOOP_THRESHOLD - 1) {
      // 第 3 次命中 → 抑制
      this.suppressGroup(match.groupId);
      return null;
    }

    // 入待处理队列（带 groupId，便于 verifiedCount 更新）
    this.pendingQueue.push({
      normalized: event.normalized,
      sourceFile: event.sourceFile,
      errorCode: event.errorCode,
      timestamp: event.timestamp,
      groupId: match.groupId,
    });

    const isWarning = groupHits >= 1; // 第 2 次降级
    return this.formatInjection(match, isWarning);
  }

  // ---- 修复检测 ----

  async onSuccess(command: string, exitCode: number): Promise<void> {
    this.turnCounter++;
    if (exitCode !== 0) return;

    // 工具执行成功 → 待处理队列全部视为可能已修复
    const resolved = [...this.pendingQueue];
    this.pendingQueue = [];

    for (const pending of resolved) {
      if (pending.groupId) {
        this.incrementVerifiedCount(pending.groupId, command, exitCode);
      } else {
        // L0/L1 未命中过的错误 → 现在消失了意味着被修复了 → 触发阶段2 入库
        const event = { normalized: pending.normalized, errorCode: pending.errorCode, raw: '', timestamp: pending.timestamp, command };
        this.stage2ExtractSolution(event, {
          error: event,
          fixTimestamp: Date.now(),
        }).catch(() => {});
      }
    }
  }

  // ---- 修复检测（带 diff） ----

  async onFixDetected(fix: FixInfo): Promise<void> {
    // 触发异步阶段2
    await this.stage2ExtractSolution(fix.error, fix);
  }

  // 暂存分组结果（单个会话内）
  private groupingCache = new Map<string, GroupingResult>();

  // ---- 异步阶段1：错误分组 ----

  private async stage1Group(event: ErrorEvent): Promise<void> {
    try {
      const groups = this.index.getAll().map((k) => ({
        groupId: k.groupId,
        summary: k.summary,
        errorTemplate: k.errorTemplate,
        occurrences: k.occurrences,
      }));

      const result = await this.analyzer.groupError(event, groups);
      const key = event.normalized + (event.sourceFile || '');
      this.groupingCache.set(key, result);
    } catch {
      // 静默失败，不影响主流程
    }
  }

  // ---- 异步阶段2：策略提取 + 入库 ----

  private async stage2ExtractSolution(event: ErrorEvent, fix: FixInfo): Promise<void> {
    try {
      const extraction = await this.analyzer.extractSolution(event, fix);
      const key = event.normalized + (event.sourceFile || '');
      const grouping = this.groupingCache.get(key);
      this.groupingCache.delete(key);

      // 若无 AI 分组结果，用 normalized 哈希生成确定性临时 ID
      const groupId = grouping?.groupId || hashGroupId(event.normalized);
      const summary = grouping?.groupSummary || 'Pending classification';
      const template = grouping?.errorTemplate || event.normalized;

      // 查找或创建知识条目
      let existing = this.index.get(groupId);

      const newSolution: import('./types').Solution = {
        id: `sol-${Date.now().toString(36)}`,
        strategy: extraction.strategy,
        rootCause: extraction.rootCause,
        avoidanceHint: extraction.avoidanceHint,
        diff: fix.diff,
        verifiedCount: 1,
        suppressed: false,
        executionTrace: {
          exitCode: 0,
          command: event.command || 'unknown',
          timestamp: Date.now(),
          dependencyVersions: event.dependencies,
        },
      };

      if (existing) {
        // 策略去重：检查是否已有语义相同的策略
        const similar = existing.solutions.find(
          (s) => s.strategy === extraction.strategy && s.rootCause === extraction.rootCause,
        );
        if (similar) {
          similar.verifiedCount++;
          similar.executionTrace = newSolution.executionTrace;
        } else {
          existing.solutions.push(newSolution);
        }
        existing.occurrences++;
        existing.lastSeen = Date.now();
        existing.dependencyVersions = event.dependencies;
        existing.solutions.sort((a, b) => b.verifiedCount - a.verifiedCount);
      } else {
        existing = {
          groupId,
          summary,
          errorTemplate: template,
          occurrences: 1,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          solutions: [newSolution],
          status: 'active',
          dependencyVersions: event.dependencies,
          category: grouping?.category || 'other',
          isProjectSpecific: grouping?.isProjectSpecific || false,
          tags: [],
          relatedGroupIds: [],
        };
      }

      // 计算 embedding
      try {
        existing.embedding = await this.embedding.embed(event.normalized);
      } catch { /* embedding 失败不阻塞 */ }

      await this.storage.upsert(existing);
    } catch {
      // 静默失败
    }
  }

  // ---- 防循环 ----

  private suppressGroup(groupId: string): void {
    const knowledge = this.index.get(groupId);
    if (!knowledge) return;
    for (const s of knowledge.solutions) {
      s.suppressed = true;
    }
    knowledge.status = 'deprecated';
    this.storage.upsert(knowledge).catch(() => {});
  }

  private incrementVerifiedCount(groupId: string, command: string, exitCode: number): void {
    const knowledge = this.index.get(groupId);
    if (!knowledge) return;
    const top = knowledge.solutions[0];
    if (top) {
      top.verifiedCount++;
      top.executionTrace = {
        exitCode,
        command,
        timestamp: Date.now(),
        dependencyVersions: knowledge.dependencyVersions,
      };
      top.suppressed = false; // 重新验证 → 解除抑制
    }
    knowledge.occurrences++;
    knowledge.lastSeen = Date.now();
    this.storage.upsert(knowledge).catch(() => {});
  }

  // ---- 注入格式化 ----

  private formatInjection(match: MatchResult, warning: boolean): string {
    const k = match.matched;
    const top = k.solutions[0];
    if (!top) return '';

    const lines = [
      `[codebrain]`,
      `fix: ${top.strategy}`,
      `root: ${top.rootCause}`,
      `avoid: ${top.avoidanceHint}`,
      `hit: ${k.occurrences}次 | v: ${top.verifiedCount}`,
    ];

    if (warning) {
      lines.push('⚠ 此方案上次未解决该问题');
    }

    // 版本差异提醒
    // TODO: 从当前上下文获取依赖版本做对比

    return lines.join('\n');
  }

  get stats(): Promise<import('./types').StorageStats> {
    return this.storage.stats();
  }

  get knowledge(): MemoryIndex {
    return this.index;
  }
}
