/**
 * LLM 调用接口。异步深路径用，走网络。
 */
export interface LLMProvider {
  complete(prompt: string, options?: { temperature?: number; maxTokens?: number }): Promise<string>;
}
