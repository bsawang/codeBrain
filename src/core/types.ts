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
  commandPrefix?: string;
  isRote?: boolean;
  roteCount?: number;
  isTrivial?: boolean;
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

export interface MatchResult {
  groupId: string;
  relevance: number;
  reason: string;
  matched: ErrorKnowledge;
  confidence?: 'high' | 'medium' | 'low';
}

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

export interface PendingError {
  normalized: string;
  sourceFile?: string;
  errorCode?: string;
  command?: string;
  groupId?: string;
  timestamp: number;
}

export interface StorageStats {
  totalGroups: number;
  totalEvents: number;
  lastUpdate: number;
}
