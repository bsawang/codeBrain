/**
 * Claude Code hook 注册/卸载。
 * 读写 ~/.claude/settings.json。
 *
 * Claude Code hook schema:
 *   { hooks: { EventName: [ { matcher: string, hooks: [ { type: "command", command: "..." } ] } ] } }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CLAUDE_HOME = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_HOME, 'settings.json');
const HOOK_SCRIPT = join(__dirname, 'hook.js');

interface HookEntry {
  type: 'command';
  command: string;
}

interface HookGroup {
  matcher: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

const CODEBRAIN_HOOK_COMMAND = `node "${HOOK_SCRIPT}"`;

function isCodebrainHook(entry: HookEntry): boolean {
  return entry.type === 'command' && entry.command.toLowerCase().includes('codebrain');
}

function hasCodebrainInGroup(group: HookGroup): boolean {
  return group.hooks.some(isCodebrainHook);
}

export function register(): void {
  const settings = loadSettings();
  if (!settings.hooks) settings.hooks = {};

  const event = 'PostToolUse';
  if (!settings.hooks[event]) {
    settings.hooks[event] = [];
  }

  // 检查是否已注册
  const alreadyRegistered = settings.hooks[event].some((g) => hasCodebrainInGroup(g));
  if (alreadyRegistered) {
    console.log('codebrain hook already registered.');
    return;
  }

  // 添加到匹配所有工具的组，若已存在空 matcher 组则追加 hook
  const catchAll = settings.hooks[event].find((g) => g.matcher === '');
  if (catchAll) {
    catchAll.hooks.push({ type: 'command', command: CODEBRAIN_HOOK_COMMAND });
  } else {
    settings.hooks[event].push({
      matcher: '',
      hooks: [{ type: 'command', command: CODEBRAIN_HOOK_COMMAND }],
    });
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
    const groups = settings.hooks[event];
    const before = groups.reduce((sum, g) => sum + g.hooks.length, 0);

    // 移除 codebrain hook 条目
    for (const group of groups) {
      group.hooks = group.hooks.filter((h) => !isCodebrainHook(h));
    }

    // 移除空组
    settings.hooks[event] = groups.filter((g) => g.hooks.length > 0);

    const after = settings.hooks[event].reduce((sum, g) => sum + g.hooks.length, 0);
    removed += before - after;

    // 清理空事件组
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  // 清理空的 hooks 对象
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
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
