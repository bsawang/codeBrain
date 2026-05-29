/**
 * DeepSeek API LLM 实现。
 */
import { LLMProvider } from './llm-provider';

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
    // 优先从环境变量读取（兼容 Claude Code 的 ANTHROPIC_AUTH_TOKEN）
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
    // DeepSeek 支持两种端点: /chat/completions (OpenAI 格式) 和 /anthropic/v1/messages
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

    if (isAnthropic) {
      // Anthropic 格式: { content: [{ type: "text", text: "..." }] }
      const content = data.content as Array<{ type: string; text: string }> | undefined;
      return content?.[0]?.text || '';
    }

    // OpenAI 格式: { choices: [{ message: { content: "..." } }] }
    const choices = data.choices as Array<{ message: { content: string } }> | undefined;
    return choices?.[0]?.message?.content || '';
  }
}
