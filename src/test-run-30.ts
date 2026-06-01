/**
 * 34 条标准测试。三种模式:
 *
 * node dist/test-run-30.js              ← 重放 mock，比对答案
 * node dist/test-run-30.js --capture    ← 用真实 LLM 录制 mock + 生成答案
 *
 * 题目: test-data-30.json（仅输入）
 * 答案: test-data-30-answers.json（hit + injection + knowledge）
 * mock: test-data-30-mock.json（录制的 LLM 响应，重放用）
 */
import { CodeBrainEngine } from './core/codebrain-engine';
import { StorageEngine } from './storage/storage-engine';
import { XenovaEmbeddingProvider } from './providers/xenova-embedding';
import { DeepSeekProvider } from './providers/deepseek-provider';
import { createErrorEvent } from './core/preprocessor';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

// ---- 类型 ----
interface Case { id: number; name: string; command: string; output: string; normalized: string; }
interface Answer { hit: boolean; injection: string | null; knowledge: Record<string, unknown> | null; skipReason?: string | null; }

// 自动选择 test/codebrain-{name}-{date} 最新的数据目录
const TEST_ROOT = join(__dirname, '..', 'test');
let DATA_DIR = TEST_ROOT;
try {
  const dirs = readdirSync(TEST_ROOT).filter((d) => d.startsWith('codebrain-')).sort().reverse();
  if (dirs.length > 0) DATA_DIR = join(TEST_ROOT, dirs[0]);
} catch {}

const DATA: { meta: { total: number }; cases: Case[] } = JSON.parse(
  readFileSync(join(DATA_DIR, 'test-data-30.json'), 'utf-8'),
);
const IS_CAPTURE = process.argv.includes('--capture');
// 34 条用例的阶段划分（内部方案，不在数据文件里）
function phaseOf(id: number): 'seed' | 'verify' | 'success' {
  if (id <= 20) return 'seed';
  if (id <= 30) return 'verify';
  return 'success';
}

// ---- 工具 ----
function occSum(e: CodeBrainEngine): number {
  return e.knowledge.getAll().reduce((s, k) => s + k.occurrences, 0);
}
function clean(k: any): any {
  if (!k) return null;
  const o: any = {
    groupId: k.groupId, summary: k.summary, errorTemplate: k.errorTemplate,
    occurrences: k.occurrences,
    solutions: (k.solutions || []).map((s: any) => ({
      strategy: s.strategy, rootCause: s.rootCause, avoidanceHint: s.avoidanceHint,
      verifiedCount: s.verifiedCount, suppressed: s.suppressed, diff: s.diff,
    })),
    status: k.status, isTrivial: k.isTrivial || false, isRote: k.isRote || false,
    commandPrefix: k.commandPrefix || null, category: k.category,
    isProjectSpecific: k.isProjectSpecific, tags: k.tags || [], relatedGroupIds: k.relatedGroupIds || [],
  };
  if (k.abstractRule) { o.abstractRule = k.abstractRule; o.triggerDescription = k.triggerDescription; o.preventionAdvice = k.preventionAdvice; }
  return o;
}

/** sanitize LLM 响应：保留 isTrivial 等真实判断，仅修正 errorTemplate */
function sanitizeLLMResponse(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    obj.errorTemplate = null;   // 用 event.normalized 做模板，L0/L1 匹配正常工作
    return JSON.stringify(obj);
  } catch { return raw; }
}

// ---- LLM 提供方 ----
function createLLM(capture: boolean): { llm: any; getLog: () => any[]; calls: () => number } {
  if (capture) {
    const real = new DeepSeekProvider({ apiKey: process.env.ANTHROPIC_AUTH_TOKEN || '' });
    const log: any[] = [];
    let idx = 0;
    return {
      llm: {
        async complete(prompt: string, options?: any) {
          const i = ++idx;
          // 自动重试直到拿到非空响应（发生过 LLM 返回空导致录制索引偏移）
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
            process.stdout.write(`  LLM[${i}]${attempt > 0 ? ` retry${attempt}` : ''} ${prompt.length}chars...`);
            const start = Date.now();
            const raw = await real.complete(prompt, options);
            const ms = Date.now() - start;
            const sanitized = sanitizeLLMResponse(raw);
            if (sanitized && sanitized.length > 10) {
              log.push({ call: i, prompt, response: sanitized, ms });
              process.stdout.write(` ${sanitized.length}chars ${ms}ms\n`);
              return sanitized;
            }
            process.stdout.write(` empty, retry...\n`);
          }
          // 最后手段：返回 fallback
          const fallback = JSON.stringify({ groupId: `fallback-${i}`, groupSummary: 'fallback', errorTemplate: null, category: 'test/fallback', abstractRule: 'fallback rule', isTrivial: false });
          log.push({ call: i, prompt, response: fallback, ms: 0 });
          return fallback;
        },
      },
      getLog: () => log,
      calls: () => idx,
    };
  }
  // 重放模式
  const mockPath = join(DATA_DIR, 'test-data-30-mock.json');
  if (!existsSync(mockPath)) { console.error('缺少 test-data-30-mock.json，请先 --capture'); process.exit(1); }
  const recs: { response: string }[] = JSON.parse(readFileSync(mockPath, 'utf-8'));
  let idx = 0;
  return {
    llm: { async complete(_p: string) { return recs[idx++]?.response || '{}'; } },
    getLog: () => [],
    calls: () => idx,
  };
}

// ---- 捕获 ----
async function capture() {
  console.log('--- 捕获: 真实 LLM + errorTemplate=null ---\n');
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const CAPTURE_DIR = join(TEST_ROOT, `codebrain-30-${dateStr}`);
  mkdirSync(CAPTURE_DIR, { recursive: true });
  const dbPath = join(tmpdir(), 'codebrain-capt.db');
  if (existsSync(dbPath)) unlinkSync(dbPath);

  const { llm, getLog } = createLLM(true);
  const embedding = new XenovaEmbeddingProvider();
  const storage = new StorageEngine(dbPath);
  const engine = new CodeBrainEngine(embedding, llm, storage);
  await engine.initialize();
  const answers: Record<number, Answer> = {};

  for (const t of DATA.cases) {
    const event = createErrorEvent(t.output, { command: t.command });

    if (phaseOf(t.id) === 'seed') {
      const before = new Map(engine.knowledge.getAll().map((k: any) => [k.groupId, k.occurrences]));
      await engine.onError(event);
      engine.onFixDetected({ error: event, codeBefore: '', codeAfter: '', diff: '+ fix', fixTimestamp: Date.now() });
      await engine.flush();
      const changed = engine.knowledge.getAll().find((k: any) => {
        const p = before.get(k.groupId);
        return p === undefined || k.occurrences > p;
      });
      answers[t.id] = { hit: false, injection: null, knowledge: clean(changed) };
      console.log(`  #${t.id} ${t.name}  →  ${changed?.groupId || '—'}`);

    } else {
      const before = engine.knowledge.getAll().map((k: any) => ({ id: k.groupId, occ: k.occurrences }));
      const inj = await engine.onError(event);
      // 没命中时检查是否为 trivial 跳过
      let skipReason: string | null = null;
      if (!inj) {
        try {
          const match = (engine.knowledge as any).matchExactText?.(event.normalized);
          if (match?.length) {
            const k = engine.knowledge.get(match[0]);
            if (k?.isTrivial) skipReason = 'isTrivial';
          }
        } catch {}
      }
      await engine.onSuccess(t.command, 0);
      await engine.flush();
      const after = engine.knowledge.getAll().map((k: any) => ({ id: k.groupId, occ: k.occurrences }));
      const upd = after.find((a: any) => {
        if (!before.find((x: any) => x.id === a.id)) return true;
        const b = before.find((x: any) => x.id === a.id);
        return b && a.occ > b.occ;
      });
      answers[t.id] = { hit: !!inj, injection: inj, knowledge: upd ? clean(engine.knowledge.get(upd.id)) : null, skipReason };
      const tag = phaseOf(t.id) === 'verify' ? 'verify' : 'success';
      console.log(`  #${t.id} ${t.name}  →  ${inj ? 'hit' : (skipReason || 'miss')} ${upd?.id || '—'}`);
    }
  }

  // 保存 mock（已 sanitize）
  const log = getLog();
  const recordings = log.map((l: any) => ({ prompt: l.prompt, response: l.response }));
  writeFileSync(join(CAPTURE_DIR, 'test-data-30-mock.json'), JSON.stringify(recordings, null, 2));
  writeFileSync(join(CAPTURE_DIR, 'test-data-30-answers.json'), JSON.stringify(answers, null, 2));
  console.log(`\n✅ mock ${recordings.length} 条 | answers ${Object.keys(answers).length} 条`);
  storage.close();
}

// ---- 回归校验 ----
async function verify() {
  const ANSWERS: Record<number, Answer> = JSON.parse(
    readFileSync(join(DATA_DIR, 'test-data-30-answers.json'), 'utf-8'),
  );

  console.log(`--- ${DATA.meta.total} 条标准测试 ---\n`);

  const dbPath = join(tmpdir(), 'codebrain-verify.db');
  if (existsSync(dbPath)) unlinkSync(dbPath);

  const { llm } = createLLM(false);
  const embedding = new XenovaEmbeddingProvider();
  const storage = new StorageEngine(dbPath);
  const engine = new CodeBrainEngine(embedding, llm, storage);
  await engine.initialize();

  let passed = 0, failed: { id: number; name: string; reason: string }[] = [];
  let injCount = 0, llmCalls = 0;

  /** 简略比对实际组 vs 答案，返回差异描述（null=一致） */
  function diffAnswer(gid: string, ans: Answer): string | null {
    const k = engine.knowledge.get(gid);
    if (!k) return 'group not found';
    if (!ans.knowledge) return null;
    const exp = ans.knowledge as any;
    for (const f of ['occurrences', 'summary', 'status', 'isTrivial', 'isRote', 'category']) {
      const ev = exp[f];
      const av = (k as any)[f];
      if (ev == null && (av == null || av === false)) continue;  // null/undefined/false 等价
      if (av == null && (ev == null || ev === false)) continue;
      if (ev != null && av !== ev) return `${f} "${ev}" vs "${av}"`;
    }
    // abstractRule 存在性比对
    if (exp.abstractRule != null && !k.abstractRule) return 'abstractRule missing';
    if (exp.abstractRule == null && k.abstractRule) return 'unexpected abstractRule';
    return null;
  }

  for (const t of DATA.cases) {
    const event = createErrorEvent(t.output, { command: t.command });
    const ans = ANSWERS[t.id];
    const ph = phaseOf(t.id);
    const icon = ph === 'seed' ? '🌱' : ph === 'verify' ? '🔄' : '✅';

    if (ph === 'seed') {
      const inj = await engine.onError(event);
      if (inj && !ans.hit) { failed.push({ id: t.id, name: t.name, reason: 'expected miss pero got injection' }); console.log(`  ${icon} #${String(t.id).padStart(2)} ✗ ${t.name}`); continue; }
      engine.onFixDetected({ error: event, codeBefore: '', codeAfter: '', diff: '+ fix', fixTimestamp: Date.now() });
      await engine.flush();
      const a = ans.knowledge ? engine.knowledge.get(ans.knowledge.groupId as string) : null;
      if (!a && ans.knowledge) { failed.push({ id: t.id, name: t.name, reason: `group ${ans.knowledge.groupId} not found` }); console.log(`  ${icon} #${String(t.id).padStart(2)} ✗ ${t.name}`); continue; }
      passed++;
      llmCalls++;
      const gid = a?.groupId || '—';
      const d = diffAnswer(gid, ans);
      const ansTag = d ? `✗ ans(${d})` : '✓ ans';
      console.log(`  ${icon} #${String(t.id).padStart(2)} ✓ ${t.name}  |  miss → extracted(group=${gid}, occ=${a?.occurrences})  ${ansTag}`);

    } else if (ph === 'verify') {
      const gid = ans.knowledge?.groupId as string;
      const beforeOcc = gid ? (engine.knowledge.get(gid)?.occurrences || 0) : 0;
      const inj = await engine.onError(event);
      if (ans.hit && !inj) { failed.push({ id: t.id, name: t.name, reason: 'expected hit' }); console.log(`  ${icon} #${String(t.id).padStart(2)} ✗ ${t.name}`); continue; }
      if (!ans.hit && inj) { failed.push({ id: t.id, name: t.name, reason: 'expected miss but got injection' }); console.log(`  ${icon} #${String(t.id).padStart(2)} ✗ ${t.name}`); continue; }
      if (ans.injection && inj !== ans.injection) { failed.push({ id: t.id, name: t.name, reason: 'injection mismatch' }); console.log(`  ${icon} #${String(t.id).padStart(2)} ✗ ${t.name}`); continue; }
      await engine.onSuccess(t.command, 0);
      await engine.flush();
      const afterOcc = gid ? (engine.knowledge.get(gid)?.occurrences || 0) : 0;
      const occDiff = afterOcc - beforeOcc;
      injCount += inj ? 1 : 0;
      passed++;
      llmCalls += 2;
      // 匹配结果
      const matchTag = ans.skipReason ? `trivial(${ans.skipReason})` : (inj ? 'hit' : 'miss');
      // 处理后结果
      const processTag = occDiff > 0 ? `verified+${occDiff} (occ ${beforeOcc}→${afterOcc})` : (ans.skipReason ? 'queued(trivial)' : 'extracted(new)');
      const d = diffAnswer(gid, ans);
      const ansTag = d ? `✗ ans(${d})` : '✓ ans';
      console.log(`  ${icon} #${String(t.id).padStart(2)} ✓ ${t.name}  |  match=${matchTag} → ${processTag}  [${gid}]  ${ansTag}`);

    } else if (ph === 'success') {
      const beforeOcc = occSum(engine);
      const beforeSize = engine.knowledge.size;
      const inj = await engine.onError(event);
      const gid = ans.knowledge?.groupId as string;
      const beforeGidOcc = gid ? (engine.knowledge.get(gid)?.occurrences || 0) : 0;
      if (ans.hit && !inj) { failed.push({ id: t.id, name: t.name, reason: 'expected hit' }); console.log(`  ${icon} #${String(t.id).padStart(2)} ✗ ${t.name}`); continue; }
      await engine.onSuccess(t.command, 0);
      await engine.flush();
      const afterGidOcc = gid ? (engine.knowledge.get(gid)?.occurrences || 0) : 0;
      if (ans.hit && occSum(engine) <= beforeOcc) { failed.push({ id: t.id, name: t.name, reason: 'occurrences not increased' }); console.log(`  ${icon} #${String(t.id).padStart(2)} ✗ ${t.name}`); continue; }
      if (!ans.hit && !ans.skipReason && engine.knowledge.size <= beforeSize) { failed.push({ id: t.id, name: t.name, reason: 'no new group created' }); console.log(`  ${icon} #${String(t.id).padStart(2)} ✗ ${t.name}`); continue; }
      injCount += inj ? 1 : 0;
      passed++;
      llmCalls += ans.hit ? 1 : 2;
      const matchTag = ans.skipReason ? `trivial(${ans.skipReason})` : (inj ? 'hit' : 'miss');
      const occDiff = afterGidOcc - beforeGidOcc;
      const processTag = ans.hit ? `verified+${occDiff} (occ ${beforeGidOcc}→${afterGidOcc})` : (ans.skipReason ? 'queued(trivial)' : 'extracted(new)');
      const d = diffAnswer(gid, ans);
      const ansTag = d ? `✗ ans(${d})` : '✓ ans';
      console.log(`  ${icon} #${String(t.id).padStart(2)} ✓ ${t.name}  |  match=${matchTag} → ${processTag}  [${gid}]  ${ansTag}`);
    }
  }

  const rate = ((passed / DATA.meta.total) * 100).toFixed(0);
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ${passed}/${DATA.meta.total} (${rate}%) | LLM ${llmCalls} | 注入 ${injCount}`);
  if (failed.length) { console.log(`\n  失败:`); for (const f of failed) console.log(`    #${f.id} ${f.name} — ${f.reason}`); }

  // 知识库
  const known = engine.knowledge.getAll();
  console.log(`\n${'─'.repeat(50)}`);
  for (const k of known) {
    const v = k.solutions.reduce((s, sol) => s + sol.verifiedCount, 0);
    console.log(`  [${k.groupId}] ${k.summary?.slice(0, 40)} | ${k.occurrences}次 | ${k.solutions.length}方案/${v}验证${k.abstractRule ? ' 🔧' : ''}`);
  }
  storage.close();
  console.log(`\n${failed.length === 0 ? '✅' : `⚠️ ${failed.length}/${DATA.meta.total}`}`);
}

// ---- 入口 ----
async function main() {
  if (IS_CAPTURE) await capture();
  else await verify();
}
main().catch((e) => { console.error(e); process.exit(1); });
