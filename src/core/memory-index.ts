import { ErrorKnowledge } from './types';

/**
 * 内存索引：L0 精确匹配 + L1 向量搜索。
 * 所有知识入库时同步更新索引，查询纯内存，< 5ms。
 */
export class MemoryIndex {
  // L0: 错误码 → groupId 列表
  private l0Index = new Map<string, string[]>();

  // L0: normalized 文本 → groupId 列表
  private l0TextIndex = new Map<string, string[]>();

  // L1: groupId → embedding
  private embeddings = new Map<string, Float32Array>();

  // L1: embedding 矩阵（行号 → groupId）
  private groupIds: string[] = [];
  private matrix: Float32Array[] = [];

  // 完整知识对象
  private knowledgeMap = new Map<string, ErrorKnowledge>();

  // ---- 索引构建 ----

  add(knowledge: ErrorKnowledge): void {
    this.knowledgeMap.set(knowledge.groupId, knowledge);

    // L0 错误码索引
    if (!this.l0Index.has('')) {
      // 从 errorTemplate 中提取错误码来建索引（如果有 TS2322 之类）
      // 实际由 AI 分析层在分组时确定
    }

    // L0 文本索引（基于 errorTemplate）
    const template = knowledge.errorTemplate;
    const existing = this.l0TextIndex.get(template) || [];
    if (!existing.includes(knowledge.groupId)) {
      existing.push(knowledge.groupId);
    }
    this.l0TextIndex.set(template, existing);

    // L1 embedding 索引
    if (knowledge.embedding) {
      this.embeddings.set(knowledge.groupId, knowledge.embedding);
      this.groupIds.push(knowledge.groupId);
      this.matrix.push(knowledge.embedding);
    }
  }

  update(knowledge: ErrorKnowledge): void {
    // 更新等同于覆盖添加
    this.remove(knowledge.groupId);
    this.add(knowledge);
  }

  remove(groupId: string): void {
    this.knowledgeMap.delete(groupId);
    this.embeddings.delete(groupId);

    // 从 l0TextIndex 中移除
    for (const [template, groups] of this.l0TextIndex) {
      const idx = groups.indexOf(groupId);
      if (idx >= 0) {
        groups.splice(idx, 1);
        if (groups.length === 0) this.l0TextIndex.delete(template);
        break;
      }
    }

    // 从矩阵中移除
    const rowIdx = this.groupIds.indexOf(groupId);
    if (rowIdx >= 0) {
      this.groupIds.splice(rowIdx, 1);
      this.matrix.splice(rowIdx, 1);
    }
  }

  /**
   * 额外注册 L0 文本索引（用 event.normalized 做 key，弥补 errorTemplate 不匹配的问题）
   */
  addTextKey(groupId: string, text: string): void {
    const existing = this.l0TextIndex.get(text) || [];
    if (!existing.includes(groupId)) {
      existing.push(groupId);
    }
    this.l0TextIndex.set(text, existing);
  }

  // ---- L0 精确匹配 ----

  matchExactCode(errorCode: string): string[] {
    return this.l0Index.get(errorCode) || [];
  }

  matchExactText(normalized: string): string[] {
    // 尝试精确匹配
    const direct = this.l0TextIndex.get(normalized);
    if (direct && direct.length > 0) return direct;

    // 如果 normalized 文本没有精确命中，尝试包含匹配
    for (const [template, groups] of this.l0TextIndex) {
      if (normalized.includes(template) || template.includes(normalized)) {
        return groups;
      }
    }
    return [];
  }

  // ---- L1 向量搜索 ----

  getEmbeddingMatrix(): { groupIds: string[]; matrix: Float32Array[] } {
    return { groupIds: this.groupIds, matrix: this.matrix };
  }

  getEmbedding(groupId: string): Float32Array | undefined {
    return this.embeddings.get(groupId);
  }

  // ---- 知识获取 ----

  get(groupId: string): ErrorKnowledge | undefined {
    return this.knowledgeMap.get(groupId);
  }

  getAll(): ErrorKnowledge[] {
    return Array.from(this.knowledgeMap.values());
  }

  get size(): number {
    return this.knowledgeMap.size;
  }
}
