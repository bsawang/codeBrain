import { EmbeddingProvider } from './embedding-provider';

/**
 * Xenova transformers + MiniLM-L6-v2 (384-dim).
 * 首次运行时下载 ~80MB ONNX 模型到缓存。
 */
export class XenovaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  private model: unknown = null;
  private initialized = false;

  async embed(text: string): Promise<Float32Array> {
    await this.ensureModel();
    try {
      // @xenova/transformers provides pipeline('feature-extraction')
      const { pipeline } = await import('@xenova/transformers');
      const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      const result = await extractor(text, { pooling: 'mean', normalize: true });
      // result is a Tensor or number array
      const data = Array.isArray(result) ? result : (result as { data: number[] }).data;
      return new Float32Array(data);
    } catch {
      // Fallback: simple hash-based embedding for dev/testing
      return this.fallbackEmbed(text);
    }
  }

  private async ensureModel(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    // 模型在首次 embed() 调用时自动下载
  }

  /**
   * 备用方案：基于字符特征的简单 embedding。用于模型未就绪时。
   */
  private fallbackEmbed(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    // Simple trigram hash → vector
    for (let i = 0; i < text.length - 2; i++) {
      const trigram = text.charCodeAt(i) * 65536 +
        text.charCodeAt(i + 1) * 256 +
        text.charCodeAt(i + 2);
      const idx = trigram % this.dimensions;
      vec[idx] += 1;
    }
    // Normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) vec[i] /= norm;
    }
    return vec;
  }
}
