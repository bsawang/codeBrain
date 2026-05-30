/**
 * codebrain daemon — 本地 HTTP 服务。
 * hook 通过 POST 通信，保持引擎实例内存状态跨调用持久。
 *
 * 启动: codebrain daemon
 * 停止: codebrain daemon stop
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { CodeBrainEngine } from '../core/codebrain-engine';
import { StorageEngine } from '../storage/storage-engine';
import { XenovaEmbeddingProvider } from '../providers/xenova-embedding';
import { DeepSeekProvider } from '../providers/deepseek-provider';
import { loadConfig } from '../config';
import { ClaudeCodeAdapter } from '../adapters/claude-code/adapter';
import { createErrorEvent, extractSourceFile } from '../core/preprocessor';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const PID_FILE = join(tmpdir(), 'codebrain-daemon.pid');
const PORT = 0; // 动态分配

interface HookRequest {
  command: string;
  output: string;
  exitCode: number;
  sessionId?: string;
  os?: string;
}

interface HookResponse {
  injected: string | null;
  error?: string;
}

let engine: CodeBrainEngine | null = null;
let adapter: ClaudeCodeAdapter | null = null;
let actualPort: number = 0;

async function getEngine(): Promise<CodeBrainEngine> {
  if (engine) return engine;

  const config = loadConfig();

  const llm = config.llm.apiKey
    ? new DeepSeekProvider({
        apiKey: config.llm.apiKey,
        model: config.llm.model,
        baseUrl: config.llm.baseUrl,
      })
    : {
        async complete() {
          return '{"isNewGroup":true,"groupId":"unknown","groupSummary":"Unknown","errorTemplate":"","isProjectSpecific":false}';
        },
      };

  const embedding = new XenovaEmbeddingProvider();
  const storage = new StorageEngine();

  engine = new CodeBrainEngine(embedding, llm, storage);
  await engine.initialize();

  adapter = new ClaudeCodeAdapter(engine);
  return engine;
}

function parseBody(req: IncomingMessage): Promise<HookRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, data: HookResponse, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// POST /hook — Claude Code PostToolUse 回调
async function handleHook(req: HookRequest): Promise<HookResponse> {
  const eng = await getEngine();
  const output = req.output || '';
  const command = req.command || '';
  const exitCode = req.exitCode || 0;

  if (!output && exitCode === 0) {
    // 空输出且成功 → 可能是修复确认
    await eng.onSuccess(command, exitCode);
    return { injected: null };
  }

  const isError = exitCode !== 0 ||
    /Error:|error:|TypeError|ReferenceError|SyntaxError|Cannot find|FAIL|stack trace/i.test(output);

  if (!isError) {
    await eng.onSuccess(command, exitCode);
    return { injected: null };
  }

  const event = createErrorEvent(output, {
    command,
    os: req.os || process.platform,
    sourceFile: extractSourceFile(output),
    sessionId: req.sessionId,
  });

  const injection = await eng.onError(event);
  return { injected: injection };
}

// GET /stats
async function handleStats(): Promise<Record<string, unknown>> {
  const eng = await getEngine();
  const s = await eng.stats;
  return { ...s, pid: process.pid, port: actualPort };
}

export async function startDaemon(): Promise<number> {
  await getEngine();

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        if (req.url === '/hook' && req.method === 'POST') {
          const body = await parseBody(req);
          const result = await handleHook(body);
          send(res, result);
        } else if (req.url === '/api/knowledge' && req.method === 'GET') {
          const eng = await getEngine();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: eng.knowledge.getAll() }));
        } else if (req.url === '/api/stats' && req.method === 'GET') {
          const eng = await getEngine();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(await eng.stats));
        } else if (req.url === '/api/daemon/stop' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ stopped: true }));
          setTimeout(() => process.exit(0), 100);
        } else if (req.url === '/api/daemon' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ pid: process.pid, port: actualPort, uptime: Math.floor(process.uptime()), running: true }));
        } else if (req.url === '/api/config' && req.method === 'GET') {
          const config = loadConfig();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(config));
        } else if (req.url === '/api/config' && req.method === 'POST') {
          const body = await parseBody(req) as unknown as Record<string, string>;
          const { writeFileSync, existsSync, mkdirSync } = await import('fs');
          const { join } = await import('path');
          const { homedir } = await import('os');
          const home = join(homedir(), '.codebrain');
          if (!existsSync(home)) mkdirSync(home, { recursive: true });
          const configPath = join(home, 'config.yaml');
          const yaml = `# codebrain config
llm:
  provider: ${body.provider||'deepseek'}
  model: ${body.model||'deepseek-v4-flash'}
  apiKey: ${body.apiKey||''}
  baseUrl: ${body.baseUrl||'https://api.deepseek.com'}
embedding:
  provider: xenova
  model: MiniLM-L6-v2
`;
          writeFileSync(configPath, yaml);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ saved: true }));
        } else if (req.url === '/health' && req.method === 'GET') {
          send(res, { injected: null });
        } else if (req.url === '/' || req.url === '/ui') {
          const uiPath = join(__dirname, '..', 'webui', 'index.html');
          try {
            const html = readFileSync(uiPath, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
          } catch { res.writeHead(404); res.end('UI not found'); }
        } else if (req.url === '/api/knowledge' && req.method === 'GET') {
          const eng = await getEngine();
          const all = eng.knowledge.getAll();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: all }));
        } else if (req.url === '/api/stats' && req.method === 'GET') {
          const eng = await getEngine();
          const s = await eng.stats;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(s));
        } else if (req.url === '/api/daemon' && req.method === 'GET') {
          const s = { pid: process.pid, port: actualPort, uptime: Math.floor(process.uptime()), running: true };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(s));
        } else {
          send(res, { injected: null, error: 'not found' }, 404);
        }
      } catch (e) {
        send(res, { injected: null, error: String(e) }, 500);
      }
    });

    server.listen(PORT, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        actualPort = addr.port;
        // Write PID file for stop command
        writeFileSync(PID_FILE, `${process.pid}\n${actualPort}`);
        resolve(actualPort);
      }
    });
  });
}

export function stopDaemon(): boolean {
  try {
    if (!existsSync(PID_FILE)) {
      console.log('Daemon 未运行。');
      return false;
    }
    const content = readFileSync(PID_FILE, 'utf-8');
    const [pidStr, portStr] = content.trim().split('\n');
    const pid = parseInt(pidStr, 10);

    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    unlinkSync(PID_FILE);
    console.log(`Daemon (pid=${pid}, port=${portStr}) 已停止。`);
    return true;
  } catch {
    return false;
  }
}

export function getDaemonPort(): number | null {
  try {
    const content = readFileSync(PID_FILE, 'utf-8');
    const [, portStr] = content.trim().split('\n');
    return parseInt(portStr, 10) || null;
  } catch {
    return null;
  }
}
