import { ErrorEvent, GroupSummary, GroupingResult, SolutionExtraction, RuleInduction, FixInfo } from './types';
import { LLMProvider } from '../providers/llm-provider';

const GROUPING_PROMPT = `你是开发错误分析专家。

分析以下错误，进行语义分组。关注语义而非文本——根因相同即使措辞不同，归入同一组。

当前错误: {{normalized_error}}
错误码: {{error_code}}
命令: {{command}}

已有分组:
{{existing_groups}}

输出 JSON（不要额外解释）:
{
  "isNewGroup": true或false,
  "groupId": "已有分组ID则引用，新建则生成grp-xxx",
  "groupSummary": "这类错误的本质（一句话）",
  "errorTemplate": "剥离项目变量后的通用错误模板",
  "category": "层级路径，如 typescript/type-mismatch 或 text/trim，最多3层",
  "isProjectSpecific": true或false
}`;

const SOLUTION_PROMPT = `你是开发错误分析专家。

分析以下错误修复，提取策略。

错误: {{normalized_error}}
修复前代码: {{code_before}}
修复后代码: {{code_after}}
Diff: {{diff}}

输出 JSON:
{
  "strategy": "修复策略（做了什么）",
  "rootCause": "根因",
  "avoidanceHint": "一句话：什么情况/写法会触发这个错误，应避免什么"
}`;

export class AIAnalyzer {
  constructor(private llm: LLMProvider) {}

  private render(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || `{{${key}}}`);
  }

  /**
   * 任务① 错误分组
   */
  async groupError(
    event: ErrorEvent,
    existingGroups: GroupSummary[],
  ): Promise<GroupingResult> {
    const existingStr = existingGroups.length > 0
      ? existingGroups.map((g) => `[${g.groupId}] ${g.summary} (${g.occurrences}次)`).join('\n')
      : '(尚无分组)';

    const prompt = this.render(GROUPING_PROMPT, {
      normalized_error: event.normalized,
      error_code: event.errorCode || '无',
      command: event.command || '未知',
      existing_groups: existingStr,
    });

    const response = await this.llm.complete(prompt, { temperature: 0, maxTokens: 300 });
    return this.parseJSON(response) as unknown as GroupingResult;
  }

  /**
   * 任务② 修复策略提取
   */
  async extractSolution(
    event: ErrorEvent,
    fix: FixInfo,
  ): Promise<SolutionExtraction> {
    const prompt = this.render(SOLUTION_PROMPT, {
      normalized_error: event.normalized,
      code_before: fix.codeBefore || '(无)',
      code_after: fix.codeAfter || '(无)',
      diff: fix.diff || '(无)',
    });

    const response = await this.llm.complete(prompt, { temperature: 0, maxTokens: 300 });
    return this.parseJSON(response) as unknown as SolutionExtraction;
  }

  /**
   * 任务③ 规则归纳（积累后触发）
   */
  async induceRule(
    groupSummary: string,
    events: Array<{ error: ErrorEvent; solution: SolutionExtraction }>,
  ): Promise<RuleInduction> {
    const eventsStr = events.map((e, i) =>
      `[${i + 1}] 错误: ${e.error.normalized} | 根因: ${e.solution.rootCause}`,
    ).join('\n');

    const prompt = `你是开发错误分析专家。

从以下多次出现的同类错误中归纳抽象规则。

分组摘要: ${groupSummary}
错误事件:
${eventsStr}

输出 JSON:
{
  "abstractRule": "归纳出的一般性规则",
  "triggerDescription": "什么情况下触发这类错误",
  "preventionAdvice": "如何预防"
}`;

    const response = await this.llm.complete(prompt, { temperature: 0, maxTokens: 300 });
    return this.parseJSON(response) as unknown as RuleInduction;
  }

  private parseJSON(response: string): Record<string, unknown> {
    try {
      return JSON.parse(response.trim());
    } catch {
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
      throw new Error(`Failed to parse AI response: ${response.slice(0, 200)}`);
    }
  }
}
