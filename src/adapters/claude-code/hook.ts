#!/usr/bin/env node
/**
 * Claude Code hook（轻量 relay）。
 * PostToolUse → 解析 payload → POST 到 daemon → 返回 additionalContext。
 * Daemon 未运行时自动启动并等待就绪。
 *
 * stdin 读取使用事件驱动 + 防抖方式，不等待 EOF。
 * 因为 Claude Code 的 hook 协议不保证在发送 payload 后关闭 stdin 管道，
 * 使用 for-await-of 等待 EOF 会造成死锁。
 */
import { spawn } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const PID_FILE = join(tmpdir(), 'codebrain-daemon.pid');
const DAEMON_START_TIMEOUT = 8000;

function getDaemonPort(): number | null {
  try {
    const content = readFileSync(PID_FILE, 'utf-8');
    const [, portStr] = content.trim().split('\n');
    return parseInt(portStr, 10) || null;
  } catch { return null; }
}

async function ensureDaemon(): Promise<number> {
  // 1. 如果有已知端口，先验证 daemon 是否存活
  const knownPort = getDaemonPort();
  if (knownPort) {
    try {
      const resp = await fetch(`http://127.0.0.1:${knownPort}/health`);
      if (resp.ok) return knownPort;
    } catch {
      // daemon 不存活，继续重启流程
    }
    process.stderr.write('[codebrain] daemon not responding, restarting...\n');
    try { unlinkSync(PID_FILE); } catch { /* 清理陈旧 PID 文件 */ }
  }

  // 2. 启动 daemon
  const cliScript = __filename.replace(/adapters[\/\\]claude-code[\/\\]hook\.js$/, 'cli/index.js');
  spawn('node', [cliScript, 'daemon', 'start'], {
    detached: true,
    stdio: 'ignore',
  }).unref();

  // 3. 等待就绪（最多 8 秒）
  const start = Date.now();
  while (Date.now() - start < DAEMON_START_TIMEOUT) {
    await new Promise((r) => setTimeout(r, 200));
    const port = getDaemonPort();
    if (port) return port;
  }

  throw new Error('[codebrain] daemon start timeout');
}

async function callDaemon(port: number, body: Record<string, unknown>): Promise<{ injected: string | null }> {
  const resp = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return { injected: null };
  return resp.json() as Promise<{ injected: string | null }>;
}

/**
 * 安全读取 stdin。
 *
 * 不使用 for-await-of（会等待 EOF）而是用 data 事件 + 防抖。
 * Claude Code 将 hook payload 作为一次性 JSON 写入 stdin，
 * 最后一个 chunk 到达后 100ms 内无新数据即认为接收完毕。
 *
 * 兜底：最长等待 30s（防止极端情况永久阻塞）。
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    // TTY 模式：非管道，无输入
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    let data = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.pause();
      resolve(data.trim());
    };

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
      // 每次收到数据重置防抖，Claude 将 JSON 作为一次 burst 发送
      clearTimeout(timer);
      timer = setTimeout(done, 100);
    });
    process.stdin.on('end', () => {
      // 如果 stdin 正常关闭（理想情况），立即完成
      clearTimeout(timer);
      done();
    });

    // 绝对兜底：30s 后强制完成
    timer = setTimeout(done, 30_000);
    process.stdin.resume();
  });
}

export async function main(): Promise<void> {
  const empty = JSON.stringify({ continue: true });

  const input = await readStdin();

  if (!input) { process.stdout.write(empty); return; }

  try {
    const payload = JSON.parse(input) as {
      session_id?: string;
      tool_name?: string;
      tool_input?: { command?: string; description?: string };
      tool_response?: {
        stdout?: string; stderr?: string;
        interrupted?: boolean; isImage?: boolean;
      };
    };

    const toolResp = payload.tool_response;
    if (!toolResp) { process.stdout.write(empty); return; }

    const output = [toolResp.stdout || '', toolResp.stderr || ''].join('\n').trim();
    const command = payload.tool_input?.command || payload.tool_input?.description || 'unknown';
    const exitCode = toolResp.interrupted === true ? 1 : 0;

    // 空输出但有 exit code → 可能是修复确认，也要通知 daemon
    if (!output && exitCode === 0) {
      // 仍然通知 daemon（可能是 fix 确认）
      const port = await ensureDaemon();
      await callDaemon(port, { command, output: '', exitCode: 0, sessionId: payload.session_id });
      process.stdout.write(empty);
      return;
    }

    const port = await ensureDaemon();
    const result = await callDaemon(port, { command, output, exitCode, sessionId: payload.session_id });

    if (!result.injected) { process.stdout.write(empty); return; }

    process.stdout.write(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `\n${result.injected}\n`,
      },
    }));
  } catch {
    process.stdout.write(empty);
  }
}

// 直接执行时自动运行，被 import/require 时不自动执行
if (typeof require !== 'undefined' && require.main === module) {
  main();
}
