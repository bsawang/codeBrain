import { ErrorEvent, ErrorKnowledge, MatchResult } from './types';
import { MemoryIndex } from './memory-index';
import { EmbeddingProvider } from '../providers/embedding-provider';
import { LLMProvider } from '../providers/llm-provider';

const L1_SIMILARITY_THRESHOLD = 0.7;

export class MatchEngine {
  constructor(
    private embedding: EmbeddingProvider,
    private llm?: LLMProvider,
  ) {}

  // ---- L0 精确匹配 (< 1ms) ----

  matchExact(event: ErrorEvent, index: MemoryIndex): MatchResult | null {
    // 1. 错误码精确匹配
    if (event.errorCode) {
      const groups = index.matchExactCode(event.errorCode);
      if (groups.length > 0) {
        // 取 verifiedCount 最高的
        const best = this.pickBest(groups, index);
        if (best) return this.toMatch(best, 1.0, 'L0 errorCode exact');
      }
    }

    // 2. normalized 文本精确匹配
    const textGroups = index.matchExactText(event.normalized);
    if (textGroups.length > 0) {
      const best = this.pickBest(textGroups, index);
      if (best) return this.toMatch(best, 1.0, 'L0 text exact');
    }

    return null;
  }

  // ---- L1 向量搜索 (~1-4ms) ----

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

    // cosine similarity 遍历
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

  // ---- 同步快路径 (< 5ms) ----

  async matchSync(event: ErrorEvent, index: MemoryIndex): Promise<MatchResult | null> {
    const l0 = this.matchExact(event, index);
    if (l0) return l0;

    const l1 = await this.matchVector(event, index, 1, L1_SIMILARITY_THRESHOLD);
    return l1.length > 0 ? l1[0] : null;
  }

  // ---- L2 LLM 语义匹配 ----

  async matchLLM(event: ErrorEvent, index: MemoryIndex): Promise<MatchResult[]> {
    if (!this.llm) return [];

    const allKnowledge = index.getAll();
    if (allKnowledge.length === 0) return [];

    const topK = allKnowledge.slice(0, 10); // 只送 Top 10 给 LLM
    const prompt = this.buildL2Prompt(event, topK);
    const response = await this.llm.complete(prompt, { temperature: 0, maxTokens: 500 });
    const parsed = this.parseL2Response(response);

    return parsed
      .map((m) => {
        const knowledge = index.get(m.groupId);
        if (!knowledge) return null;
        return this.toMatch(knowledge, m.relevance, m.reason);
      })
      .filter((m): m is MatchResult => m !== null)
      .sort((a, b) => b.relevance - a.relevance);
  }

  // ---- 辅助 ----

  private pickBest(groupIds: string[], index: MemoryIndex): ErrorKnowledge | undefined {
    return groupIds
      .map((id) => index.get(id))
      .filter((k): k is ErrorKnowledge => k !== undefined && k.status !== 'deprecated')
      .sort((a, b) => {
        // 优先未受抑制 + verifiedCount 高
        const suppressedDiff = (a.solutions.some((s) => s.suppressed) ? 1 : 0) -
          (b.solutions.some((s) => s.suppressed) ? 1 : 0);
        if (suppressedDiff !== 0) return suppressedDiff;
        const maxV = (s: ErrorKnowledge) => Math.max(0, ...s.solutions.map((sl) => sl.verifiedCount));
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

    return `分析以下错误并判断是否与历史知识匹配。
当前错误(normalized): ${event.normalized}
错误码: ${event.errorCode || '无'}
上下文: 文件=${event.sourceFile || '未知'}, 命令=${event.command || '未知'}

历史知识:
${summaries}

输出 JSON:
{"matches": [{"groupId": "...", "relevance": 0.95, "reason": "匹配理由"}]}`;
  }

  private parseL2Response(response: string): Array<{ groupId: string; relevance: number; reason: string }> {
    try {
      const json = JSON.parse(response.trim());
      return json.matches || [];
    } catch {
      // 尝试提取 JSON 块
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
