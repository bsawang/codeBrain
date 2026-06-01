/**
 * DeepSeek API LLM 实现。
 */
import { LLMProvider } from './llm-provider';

export const tokenCounts = { input: 0, output: 0 };

interface DeepSeekConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class DeepSeekProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: DeepSeekConfig) {
    this.apiKey = config.apiKey
      || process.env.ANTHROPIC_AUTH_TOKEN
      || process.env.DEEPSEEK_API_KEY
      || '';
    this.model = config.model || 'deepseek-v4-flash';
    this.baseUrl = config.baseUrl
      || process.env.ANTHROPIC_BASE_URL
      || 'https://api.deepseek.com';
  }

  async complete(prompt: string, options?: { temperature?: number; maxTokens?: number }): Promise<string> {
    const endpoint = this.baseUrl.includes('/anthropic')
      ? `${this.baseUrl}/v1/messages`
      : `${this.baseUrl}/chat/completions`;

    const isAnthropic = this.baseUrl.includes('/anthropic');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    headers[isAnthropic ? 'x-api-key' : 'Authorization'] = isAnthropic
      ? this.apiKey
      : `Bearer ${this.apiKey}`;

    if (isAnthropic) {
      headers['anthropic-version'] = '2023-06-01';
    }

    const body = isAnthropic
      ? JSON.stringify({
          model: this.model,
          max_tokens: options?.maxTokens ?? 500,
          messages: [{ role: 'user', content: prompt }],
          temperature: options?.temperature ?? 0,
        })
      : JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: options?.temperature ?? 0,
          max_tokens: options?.maxTokens ?? 500,
          stream: false,
        });

    const response = await fetch(endpoint, { method: 'POST', headers, body });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`DeepSeek API error ${response.status}: ${errText.slice(0, 300)}`);
    }

    const data = await response.json() as Record<string, unknown>;

    // 统计 token 用量（OpenAI 格式返回 usage 字段）
    const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (usage?.prompt_tokens) tokenCounts.input += usage.prompt_tokens;
    if (usage?.completion_tokens) tokenCounts.output += usage.completion_tokens;

    if (isAnthropic) {
      const content = data.content as Array<{ type: string; text?: string }> | undefined;
      const textBlock = content?.find((c) => c.type === 'text');
      return textBlock?.text || '';
    }

    const choices = data.choices as Array<{ message: { content: string } }> | undefined;
    return choices?.[0]?.message?.content || '';
  }
}
