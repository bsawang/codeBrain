// —— 错误事件与预处理 ——

export interface ErrorEvent {
  raw: string;
  normalized: string;
  errorCode?: string;
  command?: string;
  os?: string;
  sourceFile?: string;
  codeSnippet?: string;
  dependencies?: Record<string, string>;
  timestamp: number;
  sessionId?: string;
}

// —— 知识模型 ——

export interface ErrorKnowledge {
  groupId: string;
  summary: string;
  errorTemplate: string;
  embedding?: Float32Array;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
  solutions: Solution[];
  abstractRule?: string;
  preventionAdvice?: string;
  triggerDescription?: string;
  status: 'active' | 'deprecated';
  dependencyVersions?: Record<string, string>;
  category: string;
  isProjectSpecific: boolean;
  tags: string[];
  relatedGroupIds: string[];
}

export interface Solution {
  id: string;
  strategy: string;
  rootCause: string;
  avoidanceHint: string;
  diff?: string;
  verifiedCount: number;
  suppressed: boolean;
  executionTrace?: {
    exitCode: number;
    command: string;
    timestamp: number;
    dependencyVersions?: Record<string, string>;
  };
  applicableConditions?: string;
}

// —— 匹配引擎 ——

export interface MatchResult {
  groupId: string;
  relevance: number;
  reason: string;
  matched: ErrorKnowledge;
}

// —— AI 分析层 ——

export interface GroupSummary {
  groupId: string;
  summary: string;
  errorTemplate: string;
  occurrences: number;
}

export interface GroupingResult {
  isNewGroup: boolean;
  groupId: string;
  groupSummary: string;
  errorTemplate: string;
  category: string;
  isProjectSpecific: boolean;
}

export interface SolutionExtraction {
  strategy: string;
  rootCause: string;
  avoidanceHint: string;
}

export interface RuleInduction {
  abstractRule: string;
  triggerDescription: string;
  preventionAdvice: string;
}

// —— Agent 会话 ——

export interface AgentSession {
  sessionId: string;
  messages: { role: string; content: string; timestamp: number }[];
  toolExecutions: {
    command: string;
    output: string;
    exitCode: number;
    timestamp: number;
    os?: string;
  }[];
}

export interface FixInfo {
  error: ErrorEvent;
  codeBefore?: string;
  codeAfter?: string;
  diff?: string;
  fixTimestamp: number;
}

// —— 待处理队列 ——

export interface PendingError {
  normalized: string;
  sourceFile?: string;
  errorCode?: string;
  groupId?: string;             // L0/L1 命中时填入，用于 verifiedCount 更新
  timestamp: number;
}

// —— 存储 ——

export interface StorageStats {
  totalGroups: number;
  totalEvents: number;
  lastUpdate: number;
}
