/**
 * Agent 适配器基类，所有适配器实现此接口。
 * 核心引擎不依赖任何适配器，适配器通过此接口隔离。
 */
import { ErrorEvent, ErrorKnowledge, FixInfo, AgentSession } from '../core/types';
import { CodeBrainEngine } from '../core/codebrain-engine';

export interface AgentAdapter {
  readonly name: string;

  /** 从 Agent 会话提取错误 */
  extractErrors(session: AgentSession): ErrorEvent[];

  /** 提取修复信息 */
  extractFix(session: AgentSession, error: ErrorEvent): FixInfo | null;

  /** 注入知识到 Agent 上下文 */
  injectOnError(error: ErrorEvent, matched: ErrorKnowledge): string;
}

/**
 * 适配器工厂：根据名称创建适配器实例。
 * 核心引擎通过此工厂获取适配器，不直接依赖具体实现。
 */
export type AdapterFactory = (engine: CodeBrainEngine) => AgentAdapter;
