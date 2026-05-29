/**
 * Claude Code hook 注册/卸载。
 * 读写 ~/.claude/settings.json，以 "codebrain-" 前缀标记。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const CLAUDE_HOME = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_HOME, 'settings.json');
const HOOK_SCRIPT = join(__dirname, 'hook.js');

interface ClaudeHook {
  name: string;
  event: string;
  command: string;
  async?: boolean;
}

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHook[]>;
}

const CODEBRAIN_HOOKS: ClaudeHook[] = [
  {
    name: 'codebrain-error-collector',
    event: 'PostToolUse',
    command: `node "${HOOK_SCRIPT}"`,
    async: false, // 同步执行，L0/L1 < 5ms
  },
];

export function register(): void {
  const settings = loadSettings();
  if (!settings.hooks) settings.hooks = {};

  for (const hook of CODEBRAIN_HOOKS) {
    if (!settings.hooks[hook.event]) {
      settings.hooks[hook.event] = [];
    }

    // 避免重复注册
    const exists = settings.hooks[hook.event].some((h) => h.name === hook.name);
    if (!exists) {
      settings.hooks[hook.event].push(hook);
    }
  }

  saveSettings(settings);
  console.log('codebrain hooks registered for Claude Code.');
}

export function unregister(): void {
  const settings = loadSettings();
  if (!settings.hooks) {
    console.log('No hooks found.');
    return;
  }

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(
      (h) => !h.name.startsWith('codebrain-'),
    );
    removed += before - settings.hooks[event].length;

    // 清理空事件组
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  saveSettings(settings);
  console.log(`Unregistered ${removed} codebrain hook(s).`);
}

function loadSettings(): ClaudeSettings {
  try {
    const raw = readFileSync(SETTINGS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveSettings(settings: ClaudeSettings): void {
  if (!existsSync(CLAUDE_HOME)) {
    mkdirSync(CLAUDE_HOME, { recursive: true });
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}
