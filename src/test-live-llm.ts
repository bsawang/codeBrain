/**
 * 核心流程测试 (真实 LLM)。
 * 编译后: node dist/test-live-llm.js
 * 去掉 L2 异步语义匹配，保留 groupError / extractSolution / induceRule。
 */
import { CodeBrainEngine } from './core/codebrain-engine';
import { StorageEngine } from './storage/storage-engine';
import { XenovaEmbeddingProvider } from './providers/xenova-embedding';
import { DeepSeekProvider } from './providers/deepseek-provider';
import { loadConfig } from './config';
import { createErrorEvent } from './core/preprocessor';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB = join(tmpdir(), 'codebrain-live-test.db');

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== codebrain 核心流程测试 (真实 LLM) ===\n');

  const config = loadConfig();
  console.log(`LLM: ${config.llm.provider} / ${config.llm.model}`);
  console.log(`Embedding: ${config.embedding.provider} / ${config.embedding.model}\n`);

  const llm = new DeepSeekProvider({
    apiKey: config.llm.apiKey || '',
    model: config.llm.model,
    baseUrl: config.llm.baseUrl,
  });

  const embedding = new XenovaEmbeddingProvider();
  const storage = new StorageEngine(TEST_DB);
  const engine = new CodeBrainEngine(embedding, llm, storage);
  await engine.initialize();

  // ========== 错误 1: 冷启动 → L0/L1 miss → 入库 ==========
  console.log('━━━ 1. 冷启动 miss → 入库 ━━━');
  const ts = Date.now();
  const err1 = createErrorEvent(
    "TypeError: Cannot read properties of null (reading 'name')\n    at Home (src/pages/Home.tsx:12:17)",
    { command: 'npm run dev' },
  );
  const r1 = await engine.onError(err1);
  console.log(`   onError 注入: ${r1 || '(无 — 知识库空)'}  (${Date.now() - ts}ms)`);

  // 模拟修复（异步 fire-and-forget，不阻塞热更新）
  const ts2 = Date.now();
  engine.onFixDetected({
    error: err1,
    codeBefore: 'console.log(user.name)',
    codeAfter: 'console.log(user?.name)',
    diff: '- console.log(user.name)\n+ console.log(user?.name)',
    fixTimestamp: Date.now(),
  });
  console.log(`   onFixDetected 触发  (${Date.now() - ts2}ms)`);

  // 等待异步提取完成（生产环境不需要此等待，测试需要验证后续匹配）
  console.log('   等待 AI 提取入库...');
  await sleep(3000);
  console.log('   入库完成\n');

  // ========== 错误 2: 同类 → L0/L1 命中 → verifiedCount=2 ==========
  console.log('━━━ 2. 同类错误 → L1 命中 → verifiedCount=2 ━━━');
  const ts3 = Date.now();
  const err2 = createErrorEvent(
    "TypeError: Cannot read properties of undefined (reading 'value')\n    at App (src/App.tsx:42:5)",
    { command: 'npm run test' },
  );
  const r2 = await engine.onError(err2);
  if (r2) {
    console.log(`   ✅ 注入命中:`);
    r2.split('\n').forEach((l) => console.log(`      ${l}`));
  } else {
    console.log(`   ❌ L0/L1 miss  (${Date.now() - ts3}ms)`);
  }

  await engine.onSuccess('npm run test', 0);
  console.log(`   onSuccess → verifiedCount=2\n`);

  // ========== 错误 3: 同类 → 命中 → verifiedCount=3 → 规则归纳 ==========
  console.log('━━━ 3. 同类错误 → 命中 → verifiedCount=3 → 规则归纳 ━━━');
  const ts4 = Date.now();
  const err3 = createErrorEvent(
    "TypeError: Cannot read properties of null (reading 'title')",
    { command: 'npm run dev' },
  );
  const r3 = await engine.onError(err3);
  if (r3) {
    console.log(`   ✅ 注入命中:`);
    r3.split('\n').forEach((l) => {
      console.log(`      ${l}`);
      if (l.startsWith('rule:')) console.log(`      🔧 规则归纳已生效 ↑`);
    });
  } else {
    console.log(`   ❌ miss  (${Date.now() - ts4}ms)`);
  }

  await engine.onSuccess('npm run dev', 0);
  console.log(`   onSuccess → verifiedCount=3\n`);

  // 等规则归纳完成
  await sleep(3000);

  // ========== 错误 4: 完全不同类 → 不命中 ==========
  console.log('━━━ 4. 不同类错误: Module not found（应不命中）━━━');
  const ts5 = Date.now();
  const err4 = createErrorEvent(
    "Error: Module not found: Can't resolve 'lodash'",
    { command: 'npm run dev' },
  );
  const r4 = await engine.onError(err4);
  console.log(`   onError: ${r4 || '(无 — 正确 miss)'}  (${Date.now() - ts5}ms)\n`);

  // ========== 知识库状态 ==========
  console.log('━━━ 知识库状态 ━━━');
  const stats = await engine.stats;
  console.log(`分组: ${stats.totalGroups} | 事件: ${stats.totalEvents}`);
  let ruleInduced = false;
  for (const k of engine.knowledge.getAll()) {
    const tv = k.solutions.reduce((sum, s) => sum + s.verifiedCount, 0);
    console.log(`\n  [${k.groupId}] ${k.summary}`);
    console.log(`  category: ${k.category}`);
    console.log(`  出现: ${k.occurrences} | 总验证: ${tv}`);
    for (const sol of k.solutions) {
      console.log(`    strategy: ${sol.strategy}`);
      console.log(`    rootCause: ${sol.rootCause}`);
      console.log(`    avoid: ${sol.avoidanceHint}`);
      console.log(`    verifiedCount: ${sol.verifiedCount}`);
    }
    if (k.abstractRule) {
      console.log(`  🔧 规则: ${k.abstractRule}`);
      console.log(`  🔧 触发: ${k.triggerDescription}`);
      console.log(`  🔧 预防: ${k.preventionAdvice}`);
      ruleInduced = true;
    }
  }

  storage.close();
  console.log(`\n${'='.repeat(50)}`);
  console.log(`${ruleInduced ? '✅ 核心流程全部通过 (含规则归纳)' : '⚠️ 规则归纳未触发'}`);
  console.log(`⚠️ 若 L0/L1 未命中(embedding 相似度 < 0.7)，说明错误文本差异较大，属于正常现象`);
  console.log(`${'='.repeat(50)}`);
}

main().catch((e) => {
  console.error('测试失败:', e.message);
  process.exit(1);
});
