/**
 * codebrain 文件日志 — 写入 {CODEBRAIN_HOME}/codebrain.log。
 *
 * 只写文件，不干扰 console.log（后者留给 CLI 交互）。
 */
import { appendFileSync, existsSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { getCodeBrainHome } from './paths.js';

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const KEEP_LINES = 1000;           // 轮转时保留最近行数

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
type Level = (typeof LEVELS)[number];

let _logPath: string | null = null;

function logPath(): string {
  if (_logPath) return _logPath;
  const home = getCodeBrainHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  _logPath = `${home}/codebrain.log`;
  return _logPath;
}

function localTS(): string {
  const d = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

function format(level: Level, module: string, msg: string): string {
  return `[${localTS()}][${level}][${module}]${msg}\n`;
}

function rotate(path: string): void {
  try {
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.split('\n');
    if (lines.length <= KEEP_LINES) return;

    const kept = lines.slice(-KEEP_LINES).join('\n');
    writeFileSync(path, `... (truncated at ${localTS()})\n${kept}`, 'utf-8');
  } catch {
    // 轮转失败不影响写入
  }
}

function write(level: Level, module: string, msg: string): void {
  const line = format(level, module, msg);
  try {
    const path = logPath();
    // 超 10MB 自动轮转
    if (existsSync(path) && statSync(path).size >= MAX_SIZE) {
      rotate(path);
    }
    appendFileSync(path, line, 'utf-8');
  } catch {
    // 写日志失败不应阻断主流程
  }
}

export const logger = {
  debug: (module: string, msg: string) => write('DEBUG', module, msg),
  info:  (module: string, msg: string) => write('INFO',  module, msg),
  warn:  (module: string, msg: string) => write('WARN',  module, msg),
  error: (module: string, msg: string) => write('ERROR', module, msg),

  /** 返回日志文件路径 */
  path: logPath,
};

export type Logger = typeof logger;
