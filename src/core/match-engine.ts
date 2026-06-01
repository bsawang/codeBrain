import { ErrorEvent, ErrorKnowledge, MatchResult } from './types';
import { MemoryIndex } from './memory-index';
import { EmbeddingProvider } from '../providers/embedding-provider';
import { LLMProvider } from '../providers/llm-provider';

const L1_SIMILARITY_THRESHOLD = 0.80;

function extractCommandPrefix(command?: string): string | undefined {
  if (!command) return undefined;
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(/\s+/);
  const head = parts[0].toLowerCase();
  if (head === 'npx' && parts.length > 1) {
    return `npx:${parts[1].toLowerCase()}`;
  }
  return head;
}

const ECOSYSTEM_MAP: Record<string, string> = {
  node: 'node', npm: 'node', yarn: 'node', pnpm: 'node', bun: 'node',
  'ts-node': 'node', tsx: 'node', nvm: 'node',
  python: 'python', python3: 'python', pip: 'python', pip3: 'python',
  poetry: 'python', conda: 'python', uv: 'python',
  docker: 'docker', 'docker-compose': 'docker',
  psql: 'postgres', pg_isready: 'postgres', pg_dump: 'postgres',
  mysql: 'mysql', mysqldump: 'mysql',
  go: 'go', gofmt: 'go',
  cargo: 'rust', rustc: 'rust', rustup: 'rust',
  git: 'git',
};

function commandEcosystem(cmd?: string): string | undefined {
  if (!cmd) return undefined;
  if (cmd.startsWith('npx:')) return 'node';
  return ECOSYSTEM_MAP[cmd] || cmd;
}

function extractStoredCode(template: string): string | undefined {
  const m = template.match(/\b(ENOENT|EACCES|ECONNREFUSED|EADDRINUSE|EPERM|EISDIR|ENOTDIR|ENOTEMPTY|EEXIST|EINVAL|EMFILE|ENOSPC|TS\d{4}|ERR_[A-Z_]+)\b/);
  return m?.[0];
}

function errorTypePrefix(normalized: string): string | undefined {
  const m = normalized.match(/^(\w+(?:Error|Exception)|\w+\[E\d+\]|[A-Z]\w+):/);
  return m?.[1];
}

export class MatchEngine {
  constructor(
    private embedding: EmbeddingProvider,
    private llm?: LLMProvider,
  ) {}

  // ---- L0 exact match (< 1ms) ----

  matchExact(event: ErrorEvent, index: MemoryIndex): MatchResult | null {
    if (event.errorCode) {
      const groups = index.matchExactCode(event.errorCode);
      if (groups.length > 0) {
        const best = this.pickBest(groups, index);
        if (best) return this.toMatch(best, 1.0, 'L0 errorCode exact');
      }
    }
    const textGroups = index.matchExactText(event.normalized);
    if (textGroups.length > 0) {
      const best = this.pickBest(textGroups, index);
      if (best) return this.toMatch(best, 1.0, 'L0 text exact');
    }
    return null;
  }

  // ---- L1 vector search (~1-4ms) ----

  async matchVector(
    event: ErrorEvent,
    index: MemoryIndex,
    topK: number = 1,
    threshold: number = L1_SIMILARITY_THRESHOLD,
  ): Promise<MatchResult[]> {
    const { groupIds, matrix } = index.getEmbeddingMatrix();
    if (matrix.length === 0) return [];
    const queryVec = await this.embedding.embed(event.normalized);
    const dim = this.embedding.dimensions;
    const scores: { groupId: string; similarity: number }[] = [];
    for (let i = 0; i < matrix.length; i++) {
      const sim = this.cosineSimilarity(queryVec, matrix[i], dim);
      if (sim >= threshold) {
        scores.push({ groupId: groupIds[i], similarity: sim });
      }
    }
    scores.sort((a, b) => b.similarity - a.similarity);
    const top = scores.slice(0, topK);
    return top
      .map((s) => {
        const knowledge = index.get(s.groupId);
        if (!knowledge) return null;
        return this.toMatch(knowledge, s.similarity, `L1 cosine sim ${s.similarity.toFixed(3)}`);
      })
      .filter((m): m is MatchResult => m !== null);
  }

  // ---- sync fast path (< 5ms) ----

  async matchSync(event: ErrorEvent, index: MemoryIndex): Promise<MatchResult | null> {
    const l0 = this.matchExact(event, index);
    if (l0) { l0.confidence = 'high'; return l0; }

    const l1 = await this.matchVector(event, index, 1, L1_SIMILARITY_THRESHOLD);
    if (l1.length === 0) return null;

    const match = l1[0];

    // 错误类型预检: 类型不同直接拒绝
    const eventType = errorTypePrefix(event.normalized);
    const storedType = errorTypePrefix(match.matched.errorTemplate);
    if (eventType && storedType && eventType !== storedType) {
      return null;
    }

    // JSON 上下文预检
    if (event.normalized.includes(' in JSON') && !match.matched.errorTemplate.includes(' in JSON')) {
      return null;
    }

    // 极短文本预检
    if (event.normalized.length < 50 && !event.errorCode && !extractCommandPrefix(event.command)) {
      return null;
    }

    // 免确认阈值: 有类型或错误码时 0.95, 否则 0.99
    const hasEventType = !!errorTypePrefix(event.normalized);
    const hasStoredType = !!errorTypePrefix(match.matched.errorTemplate);
    const hasCode = !!(event.errorCode && extractStoredCode(match.matched.errorTemplate));
    const ultraHighThreshold = (hasEventType || hasStoredType || hasCode) ? 0.95 : 0.99;

    let confirmed = false;

    // 信号1: 极高相似度免确认
    if (match.relevance >= ultraHighThreshold) confirmed = true;

    if (!confirmed) {
      const eventCmd = extractCommandPrefix(event.command);
      const storedCmd = match.matched.commandPrefix;
      const eventCode = event.errorCode;
      const storedCode = extractStoredCode(match.matched.errorTemplate);

      // 信号2: 同生态系统
      if (eventCmd && storedCmd && match.relevance >= 0.85) {
        const eco1 = commandEcosystem(eventCmd);
        const eco2 = commandEcosystem(storedCmd);
        if (eco1 && eco2 && eco1 === eco2) confirmed = true;
      }

      // 信号3: 同错误码
      if (!confirmed && eventCode && storedCode && eventCode === storedCode) confirmed = true;

      // 拒绝: 事件有特定错误码但组没有
      if (!confirmed && eventCode && !storedCode && match.relevance < 0.95) return null;

      // 拒绝: 已知错误码冲突
      const KNOWN_CODES = ['ENOENT', 'EACCES', 'ECONNREFUSED', 'EADDRINUSE', 'EPERM', 'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EEXIST', 'EINVAL', 'EMFILE', 'ENOSPC'];
      if (eventCode && storedCode && eventCode !== storedCode
          && KNOWN_CODES.includes(eventCode) && KNOWN_CODES.includes(storedCode)) {
        return null;
      }
    }

    if (!confirmed) return null;

    match.confidence = 'medium';
    return match;
  }

  // ---- L2 LLM match ----

  async matchLLM(event: ErrorEvent, index: MemoryIndex): Promise<MatchResult[]> {
    if (!this.llm) return [];
    const allKnowledge = index.getAll();
    if (allKnowledge.length === 0) return [];
    const topK = allKnowledge.slice(0, 10);
    const prompt = this.buildL2Prompt(event, topK);
    const response = await this.llm.complete(prompt, { temperature: 0, maxTokens: 500 });
    const parsed = this.parseL2Response(response);
    return parsed
      .map((m) => {
        const knowledge = index.get(m.groupId);
        if (!knowledge) return null;
        const r = this.toMatch(knowledge, m.relevance, m.reason);
        r.confidence = 'low';
        return r;
      })
      .filter((m): m is MatchResult => m !== null)
      .sort((a, b) => b.relevance - a.relevance);
  }

  // ---- helpers ----

  private pickBest(groupIds: string[], index: MemoryIndex): ErrorKnowledge | undefined {
    return groupIds
      .map((id) => index.get(id))
      .filter((k): k is ErrorKnowledge => k !== undefined && k.status !== 'deprecated')
      .sort((a, b) => {
        const maxV = (s: any) => Math.max(0, ...s.solutions.map((sl: any) => sl.verifiedCount));
        return maxV(b) - maxV(a);
      })[0];
  }

  private toMatch(knowledge: ErrorKnowledge, relevance: number, reason: string): MatchResult {
    return { groupId: knowledge.groupId, relevance, reason, matched: knowledge };
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array, dim: number): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < dim; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private buildL2Prompt(event: ErrorEvent, topK: ErrorKnowledge[]): string {
    const summaries = topK.map((k) =>
      `[${k.groupId}] ${k.summary} | template: ${k.errorTemplate}`,
    ).join('\n');
    return `你是错误匹配专家。判断当前错误是否与历史知识中的某个组属于同一根因。

匹配规则:
- 同一工具链/生态的相同根因 → 匹配，即使措辞不同（如 npm 和 npx 的缺模块是同一类）
- 不同生态 → 不匹配，即使文本相似。判断依据是命令的首个工具名：
  * python/pip → Python 生态，不与 npm/node 匹配
  * psql/mysql/mongo → 数据库客户端生态，不与应用层 node 匹配
  * git → 版本控制生态，独立
  * docker → 容器生态，独立
  * go/cargo/mvn/gradle → 各自编译生态，互相独立
- 只返回置信度 ≥0.85 的匹配，无把握则返回空数组

当前错误:
  normalized: ${event.normalized}
  错误码: ${event.errorCode || '无'}
  命令: ${event.command || '未知'}
  文件: ${event.sourceFile || '未知'}

历史知识:
${summaries}

输出 JSON（只返回有把握的匹配，不要强行匹配）:
{"matches": [{"groupId": "...", "relevance": 0.95, "reason": "一句话理由"}]}`;
  }

  private parseL2Response(response: string): Array<{ groupId: string; relevance: number; reason: string }> {
    try {
      const json = JSON.parse(response.trim());
      return json.matches || [];
    } catch {
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const json = JSON.parse(match[0]);
          return json.matches || [];
        } catch { /* ignore */ }
      }
    }
    return [];
  }
}
