/**
 * Claude Code 适配器。
 * 翻译 Claude Code hook 协议 ↔ 核心引擎。
 * 核心引擎不知道 Claude Code 的存在。
 */
import { AgentAdapter } from '../base-adapter';
import { ErrorEvent, ErrorKnowledge, FixInfo, AgentSession } from '../../core/types';
import { CodeBrainEngine } from '../../core/codebrain-engine';
import { createErrorEvent } from '../../core/preprocessor';

/**
 * Claude Code 适配器 — 错误关键词识别。
 *
 * Claude Code hook 协议不提供真实 shell exit code，
 * 只能用输出文本检测错误。此处维护一套在 34 条标准测试
 * 上覆盖 33/34 的模式集合。
 */
const ERROR_KEYWORDS = [
  // 标准运行时错误（带冒号）
  'Error:', 'error:', 'TypeError:', 'ReferenceError:', 'SyntaxError:',
  // Node.js 模块系统
  'Cannot find module', 'Module not found', 'Command failed',
  // Shell exit 信号
  'exit code 1', 'exit code 2', 'Exit status',
  // TypeScript 编译错误
  'TS\\d{4}',
  // ESLint
  'ESLint:',
  // 测试框架
  'FAIL', 'AssertionError',
  // Node.js 括号风格系统错误：Error [ERR_*]
  'Error \\[',
  // pip 大写风格
  'ERROR:',
  // git merge 冲突
  'CONFLICT',
  // npm 生命周期
  'ELIFECYCLE',
  // Rust 编译错误：error[E0308]
  'error\\[',
  // Docker 守护进程错误
  'Error response from daemon',
];

const ERROR_RE = new RegExp(ERROR_KEYWORDS.join('|'));

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude-code';

  constructor(private engine: CodeBrainEngine) {}

  /**
   * 从 Claude Code PostToolUse hook payload 提取错误事件
   */
  extractErrors(session: AgentSession): ErrorEvent[] {
    const errors: ErrorEvent[] = [];

    for (const exec of session.toolExecutions) {
      if (this.isError(exec.output, exec.exitCode)) {
        errors.push(
          createErrorEvent(exec.output, {
            command: exec.command,
            os: exec.os || process.platform,
            sessionId: session.sessionId,
          }),
        );
      }
    }

    return errors;
  }

  /**
   * 检测修复：比较本次成功执行与之前的错误
   */
  extractFix(session: AgentSession, error: ErrorEvent): FixInfo | null {
    const lastSuccess = session.toolExecutions
      .filter((e) => e.exitCode === 0)
      .at(-1);

    if (!lastSuccess) return null;

    return {
      error,
      diff: undefined, // Claude Code hook 不直接提供 diff，需从 transcript 补充
      fixTimestamp: lastSuccess.timestamp,
    };
  }

  /**
   * 格式化注入文本
   */
  injectOnError(_error: ErrorEvent, matched: ErrorKnowledge): string {
    const top = matched.solutions[0];
    if (!top) return '';

    const lines = [
      '[codebrain]',
      `fix: ${top.strategy}`,
      `root: ${top.rootCause}`,
      `avoid: ${top.avoidanceHint}`,
      `hit: ${matched.occurrences}次 | v: ${top.verifiedCount}`,
    ];

    // 版本差异
    if (matched.dependencyVersions) {
      const deps = Object.entries(matched.dependencyVersions)
        .map(([k, v]) => `${k}@${v}`)
        .join(', ');
      lines.push(`ver: 验证于 ${deps}`);
    }

    return lines.join('\n');
  }

  isError(output: string, exitCode: number): boolean {
    if (exitCode !== 0) return true;
    return ERROR_RE.test(output);
  }
}
