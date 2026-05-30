/**
 * codebrain setup — 交互式安装向导。
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as readline from 'readline';
import { loadConfig } from '../config';

const CODEBRAIN_HOME = join(homedir(), '.codebrain');
const CLAUDE_HOME = join(homedir(), '.claude');
const CLAUDE_SETTINGS = join(CLAUDE_HOME, 'settings.json');

interface SetupResult {
  step: string;
  status: 'ok' | 'skip' | 'warn' | 'error';
  message: string;
}

type LLMProvider = 'deepseek' | 'openai' | 'anthropic';

const PROVIDER_DEFAULTS: Record<LLMProvider, { model: string; baseUrl: string }> = {
  deepseek:  { model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com' },
  openai:    { model: 'gpt-4o',            baseUrl: 'https://api.openai.com/v1' },
  anthropic: { model: 'claude-sonnet-4-6', baseUrl: 'https://api.anthropic.com' },
};

const AGENT_CHOICES = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex',       label: 'OpenAI Codex CLI' },
  { value: 'gemini',      label: 'Gemini CLI' },
  { value: 'skip',        label: '跳过（手动配置）' },
];

function ask(rl: readline.Interface, question: string, defaultVal?: string): Promise<string> {
  const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

async function configureInteractive(rl: readline.Interface): Promise<{
  provider: LLMProvider;
  model: string;
  apiKey: string;
  baseUrl: string;
  agent: string;
}> {
  // 1. LLM provider
  const provider = await ask(rl, 'LLM 提供商 (deepseek/openai/anthropic)', 'deepseek') as LLMProvider;
  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.deepseek;

  // 2. API key
  const apiKey = await ask(rl, 'API Key');

  // 3. Model
  const model = await ask(rl, '模型名称', defaults.model);

  // 4. Base URL
  const baseUrl = await ask(rl, 'API 地址', defaults.baseUrl);

  // 5. Agent
  console.log('\n可用的 Agent 适配器:');
  AGENT_CHOICES.forEach((a, i) => console.log(`  ${i + 1}. ${a.label}`));
  const agentIdx = await ask(rl, '选择 Agent（序号）', '1');
  const agent = AGENT_CHOICES[parseInt(agentIdx, 10) - 1]?.value || 'claude-code';

  return { provider, model, apiKey, baseUrl, agent };
}

export async function setup(): Promise<SetupResult[]> {
  // Splash
  const { showSplash } = await import('./splash.js');
  showSplash();
  console.log('按回车使用默认值。\n');

  const results: SetupResult[] = [];

  // 创建 readline
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // 1. ~/.codebrain/
  if (!existsSync(CODEBRAIN_HOME)) {
    mkdirSync(CODEBRAIN_HOME, { recursive: true });
    results.push({ step: 'home', status: 'ok', message: `创建 ${CODEBRAIN_HOME}` });
  } else {
    results.push({ step: 'home', status: 'skip', message: `${CODEBRAIN_HOME} 已存在` });
  }

  // 2. 交互式配置
  const configPath = join(CODEBRAIN_HOME, 'config.yaml');
  const configExists = existsSync(configPath);

  let provider = 'deepseek' as LLMProvider;
  let model = 'deepseek-v4-flash';
  let apiKey = '';
  let baseUrl = 'https://api.deepseek.com';
  let agent = 'claude-code';

  if (!configExists) {
    const cfg = await configureInteractive(rl);
    provider = cfg.provider;
    model = cfg.model;
    apiKey = cfg.apiKey;
    baseUrl = cfg.baseUrl;
    agent = cfg.agent;

    const yaml = `# codebrain config
llm:
  provider: ${provider}
  model: ${model}
  apiKey: ${apiKey || 'sk-your-key'}
  baseUrl: ${baseUrl}
embedding:
  provider: xenova
  model: MiniLM-L6-v2
`;
    writeFileSync(configPath, yaml);
    results.push({ step: 'config', status: 'ok', message: `${configPath}` });
  } else {
    const existing = readFileSync(configPath, 'utf-8');
    if (existing.includes('sk-your-key') || !existing.includes('apiKey:')) {
      const update = await ask(rl, 'config.yaml 无 API key，是否现在配置？(y/n)', 'y');
      if (update.toLowerCase() === 'y') {
        apiKey = await ask(rl, 'API Key');
        const updated = existing.replace(/apiKey:.*/, `apiKey: ${apiKey}`);
        writeFileSync(configPath, updated);
        results.push({ step: 'config', status: 'ok', message: '已更新 API key' });
      } else {
        results.push({ step: 'config', status: 'warn', message: '请稍后编辑 config.yaml' });
      }
    } else {
      results.push({ step: 'config', status: 'skip', message: 'config.yaml 已配置' });
    }
  }

  rl.close();

  // 3. Agent hooks
  if (agent === 'claude-code') {
    try {
      let settings: Record<string, unknown> = {};
      if (existsSync(CLAUDE_SETTINGS)) {
        settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf-8'));
      }

      const hooks = (settings.hooks || {}) as Record<string, Array<Record<string, unknown>>>;
      const postToolUse = (hooks.PostToolUse || []) as Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
      const hookScript = join(__dirname, '..', 'adapters', 'claude-code', 'hook.js');
      const hookCmd = `node "${hookScript}"`;

      const hasCodebrain = postToolUse.some(
        (g) => (g.hooks || []).some((h: Record<string, unknown>) => String(h.command || '').toLowerCase().includes('codebrain')),
      );

      if (!hasCodebrain) {
        if (!hooks.PostToolUse) hooks.PostToolUse = [];

        // 附加到现有空 matcher 组，或创建新组
        const catchAll = postToolUse.find((g) => g.matcher === '');
        if (catchAll) {
          if (!catchAll.hooks) catchAll.hooks = [];
          catchAll.hooks.push({ type: 'command', command: hookCmd });
        } else {
          postToolUse.push({
            matcher: '',
            hooks: [{ type: 'command', command: hookCmd }],
          });
        }

        hooks.PostToolUse = postToolUse;
        settings.hooks = hooks;
        if (!existsSync(CLAUDE_HOME)) mkdirSync(CLAUDE_HOME, { recursive: true });
        writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
        results.push({ step: 'hooks', status: 'ok', message: `注册到 Claude Code` });
      } else {
        results.push({ step: 'hooks', status: 'skip', message: '已注册' });
      }
    } catch (e) {
      results.push({ step: 'hooks', status: 'error', message: `失败: ${e}` });
    }
  } else if (agent === 'skip') {
    results.push({ step: 'hooks', status: 'skip', message: '跳过' });
  } else {
    results.push({ step: 'hooks', status: 'warn', message: `${agent} 适配器尚未实现，请稍后手动配置` });
  }

  // 4. 后台启动 Daemon
  const { getDaemonPort } = await import('../daemon/server.js');
  const port = getDaemonPort();
  if (port) {
    results.push({ step: 'daemon', status: 'skip', message: `已运行 (port ${port})` });
  } else {
    const { spawn } = await import('child_process');
    const cliScript = join(__dirname, 'index.js');
    spawn('node', [cliScript, 'daemon', 'start'], {
      detached: true,
      stdio: 'ignore',
    }).unref();

    // 等待就绪
    const start = Date.now();
    let daemonPort: number | null = null;
    while (Date.now() - start < 10000) {
      await new Promise((r) => setTimeout(r, 300));
      daemonPort = getDaemonPort();
      if (daemonPort) break;
    }

    if (daemonPort) {
      results.push({ step: 'daemon', status: 'ok', message: `已启动 http://127.0.0.1:${daemonPort}` });
    } else {
      results.push({ step: 'daemon', status: 'warn', message: '启动超时，稍后执行 codebrain daemon start' });
    }
  }

  return results;
}
