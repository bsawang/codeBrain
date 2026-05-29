import { ErrorEvent } from './types';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ANSI_CSI_RE = /\x1b\[[?]?\d+[a-zA-Z]/g;
const PATH_RE = /(?:\/[^\s:,"'(){}\[\]]+)+(?:\.[a-zA-Z]+)?/g;
const WIN_PATH_RE = /(?:[A-Za-z]:\\[^\s:,"'(){}\[\]]+)+(?:\.[a-zA-Z]+)?/g;
const LINE_RE = /:\d+(?::\d+)?/g;
const TIMESTAMP_RE = /\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const HEX_RE = /0x[0-9a-fA-F]+/g;
const NUM_RE = /\b\d+\b/g;
const URL_RE = /https?:\/\/[^\s]+/g;

// 错误码：TS/ESLint/Node.js/通用
const ERROR_CODE_PATTERNS = [
  /\bTS\d{4}\b/g,                                    // TS2322
  /\bESLint:[^\s:]+/g,                               // ESLint:no-unused-vars
  /\b(ENOENT|EACCES|ECONNREFUSED|EADDRINUSE|EPERM|EISDIR|ENOTDIR|ENOTEMPTY|EEXIST|EINVAL|EMFILE|ENOSPC)\b/g,
  /\bERR_[A-Z_]+\b/g,                                // ERR_MODULE_NOT_FOUND
  /\b[A-Z]+-\d+\b/g,                                 // MODULE_NOT_FOUND-404
  /\bpanic:\s/g,                                      // Go panic
  /\bP\d{4}\b/g,                                     // Python lint (PEP8)
  /\bRUSTC:\s[A-Z]\d+\b/g,                            // Rust compiler
];

export function preprocess(raw: string): string {
  let text = raw
    .replace(ANSI_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  // 截断：只保留前 2000 字符
  if (text.length > 2000) {
    text = text.slice(0, 2000) + '\n...[truncated]';
  }

  text = text
    .replace(URL_RE, '<URL>')
    .replace(WIN_PATH_RE, '<FILE>')
    .replace(PATH_RE, '<FILE>')
    .replace(LINE_RE, ':<LINE>')
    .replace(TIMESTAMP_RE, '<TS>')
    .replace(HEX_RE, '<HEX>')
    .replace(NUM_RE, '<NUM>')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

export function extractErrorCode(raw: string): string | undefined {
  const clean = raw.replace(ANSI_RE, '').replace(ANSI_CSI_RE, '');
  for (const re of ERROR_CODE_PATTERNS) {
    const match = clean.match(re);
    if (match) return match[0];
  }
  return undefined;
}

/**
 * 从原始输出中提取第一个项目文件路径
 */
export function extractSourceFile(raw: string): string | undefined {
  const clean = raw.replace(ANSI_RE, '').replace(ANSI_CSI_RE, '');
  // "at Func (src/App.tsx:42:5)" 或 "at src/App.tsx:42"
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
