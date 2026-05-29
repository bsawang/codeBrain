/**
 * 文本 → 向量。本地模型推理，不走网络。
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  /** 向量维度 */
  readonly dimensions: number;
}
