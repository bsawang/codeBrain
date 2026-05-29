#!/usr/bin/env node
/**
 * Claude Code hook（轻量 relay）。
 * PostToolUse → 解析 payload → POST 到 daemon → 返回 additionalContext。
 * Daemon 未运行时自动启动并等待就绪。
 */
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
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
  let port = getDaemonPort();
  if (port) return port;

  // 启动 daemon
  const cliScript = __filename.replace(/adapters[\/\\]claude-code[\/\\]hook\.js$/, 'cli/index.js');
  spawn('node', [cliScript, 'daemon', 'start'], {
    detached: true,
    stdio: 'ignore',
  }).unref();

  // 等待就绪（最多 8 秒）
  const start = Date.now();
  while (Date.now() - start < DAEMON_START_TIMEOUT) {
    await new Promise((r) => setTimeout(r, 200));
    port = getDaemonPort();
    if (port) return port;
  }

  throw new Error('Daemon start timeout');
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

async function main(): Promise<void> {
  const empty = JSON.stringify({ continue: true });

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const input = Buffer.concat(chunks).toString('utf-8').trim();

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

main();
