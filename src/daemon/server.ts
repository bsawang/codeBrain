import { createServer, IncomingMessage, ServerResponse } from 'http';
import { CodeBrainEngine } from '../core/codebrain-engine';
import { StorageEngine } from '../storage/storage-engine';
import { XenovaEmbeddingProvider } from '../providers/xenova-embedding';
import { DeepSeekProvider, tokenCounts } from '../providers/deepseek-provider';
import { loadConfig } from '../config';
import { ClaudeCodeAdapter } from '../adapters/claude-code/adapter';
import { createErrorEvent, extractSourceFile } from '../core/preprocessor';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../logger.js';

const PID_FILE = join(tmpdir(), 'codebrain-daemon.pid');
const PORT = 0;

interface HookRequest { command: string; output: string; exitCode: number; sessionId?: string; os?: string; }
interface HookResponse { injected: string | null; error?: string; }

let engine: CodeBrainEngine | null = null;
let adapter: ClaudeCodeAdapter | null = null;
let actualPort: number = 0;

async function getEngine(): Promise<CodeBrainEngine> {
  if (engine) return engine;
  const config = loadConfig();

  const llm = config.llm.apiKey
    ? new DeepSeekProvider({ apiKey: config.llm.apiKey, model: config.llm.model, baseUrl: config.llm.baseUrl })
    : { async complete() { return '{"isNewGroup":true,"groupId":"unknown","groupSummary":"Unknown","errorTemplate":"","isProjectSpecific":false}'; } };

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
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, data: HookResponse, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleHook(req: HookRequest): Promise<HookResponse> {
  const eng = await getEngine();
  const output = req.output || '';
  const command = req.command || '';
  const exitCode = req.exitCode || 0;
  logger.info('daemon', `hook cmd="${command.slice(0, 80)}" exit=${exitCode}`);

  if (!output && exitCode === 0) { await eng.onSuccess(command, exitCode); return { injected: null }; }

  const isError = exitCode !== 0 ||
    /Error:|error:|TypeError|ReferenceError|SyntaxError|Cannot find|FAIL|stack trace/i.test(output);

  if (!isError) { await eng.onSuccess(command, exitCode); return { injected: null }; }

  const event = createErrorEvent(output, { command, os: req.os || process.platform, sourceFile: extractSourceFile(output), sessionId: req.sessionId });
  const injection = await eng.onError(event);
  return { injected: injection };
}

export async function startDaemon(): Promise<number> {
  process.title = 'codebrain-daemon';
  await getEngine();
  logger.info('daemon', 'starting...');

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        if (req.url === '/hook' && req.method === 'POST') {
          const body = await parseBody(req);
          send(res, await handleHook(body));
        } else if (req.url === '/api/knowledge' && req.method === 'GET') {
          const eng = await getEngine();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: eng.knowledge.getAll() }));
        } else if (req.url === '/api/tokens' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(tokenCounts));
        } else if (req.url === '/api/stats' && req.method === 'GET') {
          const eng = await getEngine();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(await eng.stats));
        } else if (req.url === '/api/daemon/stop' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ stopped: true }));
          setTimeout(() => process.exit(0), 100);
        } else if (req.url === '/health' && req.method === 'GET') {
          send(res, { injected: null });
        } else if (req.url === '/' || req.url === '/ui') {
          const uiDir = join(__dirname, '..', '..', 'webui');
          // Vite build result 优先，否则用源码
          const candidates = [join(uiDir, 'dist', 'index.html'), join(uiDir, 'index.html')];
          let html: string | null = null;
          for (const p of candidates) {
            try { html = readFileSync(p, 'utf-8'); break; } catch {}
          }
          if (html) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
          } else {
            res.writeHead(404);
            res.end('UI not found');
          }
        } else if (req.url === '/api/daemon' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ pid: process.pid, port: actualPort, uptime: Math.floor(process.uptime()), running: true }));
        } else if (req.url === '/api/config' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(loadConfig()));
        } else if (req.url === '/api/knowledge/delete' && req.method === 'POST') {
          const body = await parseBody(req) as any;
          const eng = await getEngine();
          await eng.deleteKnowledge(body.groupId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ deleted: body.groupId }));
        } else if (req.url === '/api/knowledge/suppress' && req.method === 'POST') {
          const body = await parseBody(req) as any;
          const eng = await getEngine();
          await eng.toggleSuppress(body.groupId, body.suppressed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ updated: body.groupId, suppressed: body.suppressed }));
        } else if (req.url === '/api/knowledge/rote' && req.method === 'POST') {
          const body = await parseBody(req) as any;
          const eng = await getEngine();
          await eng.toggleRote(body.groupId, body.isRote);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ updated: body.groupId, isRote: body.isRote }));
        } else if (req.url === '/api/knowledge/trivial' && req.method === 'POST') {
          const body = await parseBody(req) as any;
          const eng = await getEngine();
          await eng.toggleTrivial(body.groupId, body.isTrivial);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ updated: body.groupId, isTrivial: body.isTrivial }));
        } else {
          send(res, { injected: null, error: 'not found' }, 404);
        }
      } catch (e) { send(res, { injected: null, error: String(e) }, 500); }
    });

    server.listen(PORT, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        actualPort = addr.port;
        writeFileSync(PID_FILE, `${process.pid}\n${actualPort}`);
        logger.info('daemon', `listening http://127.0.0.1:${actualPort} pid=${process.pid}`);
        resolve(actualPort);
      }
    });
  });
}

export function stopDaemon(): boolean {
  try {
    if (!existsSync(PID_FILE)) { console.log('Daemon not running.'); return false; }
    const content = readFileSync(PID_FILE, 'utf-8');
    const [pidStr, portStr] = content.trim().split('\n');
    try { process.kill(parseInt(pidStr, 10), 'SIGTERM'); } catch {}
    unlinkSync(PID_FILE);
    console.log(`Daemon stopped pid=${pidStr} port=${portStr}`);
    return true;
  } catch { return false; }
}

export function getDaemonPort(): number | null {
  try {
    const [, portStr] = readFileSync(PID_FILE, 'utf-8').trim().split('\n');
    return parseInt(portStr, 10) || null;
  } catch { return null; }
}
