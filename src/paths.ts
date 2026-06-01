/**
 * codebrain 路径解析 — 支持自定义数据目录。
 *
 * 优先级:
 *   1. CODEBRAIN_HOME 环境变量（临时覆盖）
 *   2. ~/.codebrain_rc 持久化配置
 *   3. 默认 ~/.codebrain/
 */
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';

const RC_FILE = join(homedir(), '.codebrain_rc');

export function getRcPath(): string {
  return RC_FILE;
}

export function getCodeBrainHome(): string {
  // 1. 环境变量（最高优先级）
  if (process.env.CODEBRAIN_HOME) {
    return process.env.CODEBRAIN_HOME;
  }

  // 2. rc 文件（持久化配置）
  try {
    if (existsSync(RC_FILE)) {
      const rc = readFileSync(RC_FILE, 'utf-8').trim();
      if (rc) return rc;
    }
  } catch {
    // 读取失败 → fallthrough
  }

  // 3. 默认
  return join(homedir(), '.codebrain');
}

export function getConfigPath(): string {
  return join(getCodeBrainHome(), 'config.yaml');
}

export function getDbPath(): string {
  return join(getCodeBrainHome(), 'knowledge.db');
}
