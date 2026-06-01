import { ErrorEvent, SolutionExtraction, RuleInduction, FixInfo } from './types';
import { LLMProvider } from '../providers/llm-provider';


const MERGED_RULE_PROMPT = `你是一个错误修复分析师。分析以下错误和对应的修复 diff，完成两项任务：① 错误分组 ② 提取抽象修复规则。

这条规则将在同类错误出现时注入给 AI，指导修复方向。

规则要求：
- 包含判断条件（什么错误特征触发）
- 包含具体操作步骤（AI 该做什么来修）
- 不引用具体文件名、变量名、行号等实例信息
- **禁止使用 <STR>、<FILE>、<FUNC>、<NUM>、<PATH>、<NIL> 等归一化占位符**
- 输出中的描述应该是对开发者有实际帮助的自然语言

错误(normalized): {{normalized_error}}
Diff: {{diff}}

输出 JSON:
{
  "groupId": "简短语义ID，英文小写+连字符",
  "groupSummary": "这类错误的本质（一句话）",
  "errorTemplate": "剥离变量后的通用模板",
  "category": "层级路径，如 node/module-not-found",
  "abstractRule": "抽象修复原则",
  "triggerDescription": "触发条件",
  "preventionAdvice": "如何预防",
  "isTrivial": true或false — 是否为"显然的错误"：只需要执行标准环境操作（如 npm install、kill 进程、chmod、创建目录）就能修复，不需要理解项目上下文
}`;

const MERGED_SOLUTION_PROMPT = `分析以下错误，完成两项任务：① 错误分组 ② 提取解决方案。

错误: {{normalized_error}}
修复前代码: {{code_before}}
修复后代码: {{code_after}}
Diff: {{diff}}

输出 JSON:
{
  "groupId": "简短语义ID，英文小写+连字符",
  "groupSummary": "这类错误的本质（一句话）",
  "errorTemplate": "剥离变量后的通用模板",
  "category": "层级路径",
  "strategy": "修复策略（做了什么）",
  "rootCause": "根因",
  "avoidanceHint": "一句话：什么情况/写法会触发这个错误",
  "isTrivial": true或false — 是否为"显然的错误"：只需要执行标准环境操作（如 npm install、kill 进程、chmod、创建目录）就能修复，不需要理解项目上下文
}`;

export class AIAnalyzer {
  constructor(private llm: LLMProvider) {}

  private render(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || `{{${key}}}`);
  }


  async extractSolution(
    event: ErrorEvent,
    fix: FixInfo,
  ): Promise<Record<string, unknown>> {
    if (fix.diff) {
      const prompt = this.render(MERGED_RULE_PROMPT, {
        normalized_error: event.normalized,
        diff: fix.diff,
      });
      const response = await this.llm.complete(prompt, { temperature: 0, maxTokens: 1000 });
      return this.parseJSON(response);
    }
    const prompt = this.render(MERGED_SOLUTION_PROMPT, {
      normalized_error: event.normalized,
      code_before: fix.codeBefore || '(无)',
      code_after: fix.codeAfter || '(无)',
      diff: '(无)',
    });
    const response = await this.llm.complete(prompt, { temperature: 0, maxTokens: 1000 });
    return this.parseJSON(response);
  }

  async induceRule(
    groupSummary: string,
    events: Array<{ error: ErrorEvent; solution: SolutionExtraction }>,
  ): Promise<RuleInduction> {
    const eventsStr = events.map((e, i) =>
      `[${i + 1}] 错误: ${e.error.normalized} | 根因: ${e.solution.rootCause}`,
    ).join('\n');

    const prompt = `从以下多次出现的同类错误中归纳抽象规则。

分组摘要: ${groupSummary}
错误事件:
${eventsStr}

输出 JSON:
{
  "abstractRule": "归纳出的一般性规则",
  "triggerDescription": "什么情况下触发这类错误",
  "preventionAdvice": "如何预防"
}`;

    const response = await this.llm.complete(prompt, { temperature: 0, maxTokens: 1000 });
    return this.parseJSON(response) as unknown as RuleInduction;
  }

  private parseJSON(response: string): Record<string, unknown> {
    let text = response.trim();
    text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');

    try { return JSON.parse(text); } catch {}

    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }

    try {
      const repaired = this.repairTruncatedJSON(text);
      if (repaired) return repaired;
    } catch {}

    const ngMatch = text.match(/\{[^{}]*\{[\s\S]*?\}[^{}]*\}/);
    if (ngMatch) {
      try { return JSON.parse(ngMatch[0]); } catch {}
    }

    throw new Error(`Failed to parse AI response: ${text.slice(0, 200)}`);
  }

  private repairTruncatedJSON(text: string): Record<string, unknown> | null {
    let t = text.replace(/^[^{]*/, '');
    let depth = 0, inString = false, escape = false, lastValidEnd = 0;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') { depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0) { lastValidEnd = i + 1; }
      }
    }
    if (lastValidEnd > 0 && lastValidEnd < t.length) {
      const valid = t.slice(0, lastValidEnd);
      let trimmed = valid;
      const lastComma = trimmed.lastIndexOf(',');
      const lastBrace = trimmed.lastIndexOf('}');
      if (lastComma > 0 && lastComma > lastBrace) {
        trimmed = trimmed.slice(0, lastComma);
      }
      const toClose = (t.slice(0, lastValidEnd).match(/\{/g) || []).length -
                       (t.slice(0, lastValidEnd).match(/\}/g) || []).length;
      for (let j = 0; j < toClose; j++) trimmed += '}';
      try { return JSON.parse(trimmed + '}'); } catch {}
    }
    return null;
  }
}
