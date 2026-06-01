import { ErrorEvent } from './types';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ANSI_CSI_RE = /\x1b\[[?]?\d+[a-zA-Z]/g;
const PATH_RE = /(?:\/[^\s:,"'(){}\[\]]+)+(?:\.[a-zA-Z]+)?/g;
const WIN_PATH_RE = /(?:[A-Za-z]:\\[^\s:,"'(){}\[\]]+)+(?:\.[a-zA-Z]+)?/g;
const REL_PATH_RE = /\b\w[\w\-.]*\/[\w\-.\/]*\.\w{2,5}\b/g;
const LINE_RE = /:\d+(?::\d+)?/g;
const TIMESTAMP_RE = /\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const HEX_RE = /0x[0-9a-fA-F]+/g;
const NUM_RE = /\b\d+\b/g;
const URL_RE = /https?:\/\/[^\s]+/g;

const NULLISH_RE = /\bnull\b|\bundefined\b/gi;
const PROP_READ_RE = /\(reading '[^']*'\)/g;
const FUNC_STACK_RE = /at\s+[a-zA-Z_$][\w$.]+(?=\s*\()/g;
const FUNC_STACK_END_RE = /at\s+[a-zA-Z_$][\w$.]+\s*$/gm;
const QUOTED_STR_RE = /'[^']*'|"[^"]*"/g;
const GIT_BRANCH_RE = /\[rejected\]\s+\S+\s+->\s+\S+/g;
const GIT_BRANCH_SIMPLE = /(\S+)\s+->\s+(\S+)\s+\(non-fast-forward\)/g;
const SYNTAX_TOKEN_RE = /Unexpected (?:token|identifier|string|number)(?=\s+['"])/gi;

const ERROR_CODE_PATTERNS = [
  /\bTS\d{4}\b/g,
  /\bE\d{4}\b/g,
  /\bESLint:[^\s:]+/g,
  /\b(ENOENT|EACCES|ECONNREFUSED|EADDRINUSE|EPERM|EISDIR|ENOTDIR|ENOTEMPTY|EEXIST|EINVAL|EMFILE|ENOSPC)\b/g,
  /\bERR_[A-Z_]+\b/g,
  /\b[A-Z]+-\d+\b/g,
  /\bpanic:\s/g,
  /\bP\d{4}\b/g,
  /\bRUSTC:\s[A-Z]\d+\b/g,
];

export function preprocess(raw: string): string {
  let text = raw
    .replace(ANSI_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  if (text.length > 2000) {
    text = text.slice(0, 2000) + '\n...[truncated]';
  }

  // 统一非标准错误消息起始格式
  // esbuild: "✘ [ERROR] Could not resolve ..." -> "Error: Could not resolve ..."
  text = text.replace(/^[^\w]*\[ERROR\]\s*/i, 'Error: ');
  // Java: strip "Exception in thread "main" " prefix
  text = text.replace(/^Exception in thread "[^"]*"\s*/, '');
  // Java: "java.lang.ClassNotFoundException: ..." -> "ClassNotFoundException: ..."
  text = text.replace(/\bjava\.lang\.(\w+Exception:\s*)/g, '$1');

  text = text
    .replace(URL_RE, '<URL>')
    .replace(GIT_BRANCH_RE, '[rejected] <BRANCH> -> <BRANCH>')
    .replace(GIT_BRANCH_SIMPLE, '<BRANCH> -> <BRANCH> (non-fast-forward)')
    .replace(WIN_PATH_RE, '<FILE>')
    .replace(PATH_RE, '<FILE>')
    .replace(REL_PATH_RE, '<FILE>')
    .replace(LINE_RE, ':<LINE>')
    .replace(TIMESTAMP_RE, '<TS>')
    .replace(HEX_RE, '<HEX>')
    .replace(NUM_RE, '<NUM>')
    .replace(SYNTAX_TOKEN_RE, 'Unexpected <SYNTAX>')
    .replace(NULLISH_RE, '<NIL>')
    .replace(PROP_READ_RE, "(reading '<PROP>')")
    .replace(FUNC_STACK_RE, 'at <FUNC>')
    .replace(FUNC_STACK_END_RE, 'at <FUNC>')
    .replace(QUOTED_STR_RE, '<STR>')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

export function extractErrorCode(raw: string): string | undefined {
  const clean = raw.replace(ANSI_RE, '').replace(ANSI_CSI_RE, '');
  const body = clean.split(/\n\s+at\s/)[0];
  for (const re of ERROR_CODE_PATTERNS) {
    const match = body.match(re);
    if (match) return match[0];
  }
  return undefined;
}

export function extractSourceFile(raw: string): string | undefined {
  const clean = raw.replace(ANSI_RE, '').replace(ANSI_CSI_RE, '');
  const m = clean.match(/at\s+(?:.*?\()?([\w\-.\\/]+\.\w{2,5}):\d+/);
  if (!m) return undefined;
  const file = m[1];
  return file.includes('node_modules') ? undefined : file;
}

export function createErrorEvent(
  raw: string,
  context?: {
    command?: string;
    os?: string;
    sourceFile?: string;
    codeSnippet?: string;
    dependencies?: Record<string, string>;
    sessionId?: string;
  },
): ErrorEvent {
  return {
    raw,
    normalized: preprocess(raw),
    errorCode: extractErrorCode(raw),
    command: context?.command,
    os: context?.os,
    sourceFile: context?.sourceFile,
    codeSnippet: context?.codeSnippet,
    dependencies: context?.dependencies,
    timestamp: Date.now(),
    sessionId: context?.sessionId,
  };
}
