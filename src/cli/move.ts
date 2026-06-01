/**
 * codebrain move — 迁移数据文件到目标目录。
 *
 * 用法: codebrain move <target-dir>
 *
 * 操作:
 *   1. 移动 config.yaml 和 knowledge.db 到目标目录
 *   2. 更新 ~/.codebrain_rc 指向新目录
 *   3. 提示清理旧目录（如果已空）
 */
import { existsSync, mkdirSync, renameSync, unlinkSync, rmdirSync, readdirSync, writeFileSync } from 'fs';
import { resolve, isAbsolute, basename } from 'path';
import { getCodeBrainHome, getRcPath } from '../paths.js';

export interface MoveResult {
  file: string;
  status: 'moved' | 'skipped' | 'error';
  message: string;
}

export function moveData(targetDir: string): MoveResult[] {
  const source = getCodeBrainHome();
  const results: MoveResult[] = [];

  // 规范化目标路径（支持相对路径）
  const target = isAbsolute(targetDir) ? targetDir : resolve(process.cwd(), targetDir);

  // 校验：不能移动到自身
  if (target === source) {
    results.push({ file: '-', status: 'error', message: `目标与当前目录相同: ${source}` });
    return results;
  }

  // 创建目标目录
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
  }

  const files = ['config.yaml', 'knowledge.db'];

  for (const file of files) {
    const srcPath = `${source}/${file}`;
    const dstPath = `${target}/${file}`;

    if (!existsSync(srcPath)) {
      results.push({ file, status: 'skipped', message: `源文件不存在` });
      continue;
    }

    if (existsSync(dstPath)) {
      // 目标已存在 → 先删除再移动
      try { unlinkSync(dstPath); } catch {}
    }

    try {
      renameSync(srcPath, dstPath);
      results.push({ file, status: 'moved', message: `${srcPath} → ${dstPath}` });
    } catch (e) {
      results.push({ file, status: 'error', message: `${file}: ${e}` });
    }
  }

  // 更新 rc 文件
  writeFileSync(getRcPath(), target);
  results.push({ file: '.codebrain_rc', status: 'moved', message: `→ ${target}` });

  // 检查旧目录是否已空
  try {
    const remaining = readdirSync(source).filter((f: string) => f !== '.' && f !== '..');
    if (remaining.length === 0) {
      rmdirSync(source);
      results.push({ file: basename(source), status: 'moved', message: `已清理空目录: ${source}` });
    } else {
      results.push({ file: basename(source), status: 'skipped', message: `目录非空，保留: ${remaining.join(', ')}` });
    }
  } catch {
    // 目录不存在或无法读取 → 忽略
  }

  return results;
}
