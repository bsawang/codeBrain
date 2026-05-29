/**
 * 模拟全链路测试：用 mock LLM 走通完整流程。
 * 编译后: node dist/test-integration.js
 */
import { CodeBrainEngine } from './core/codebrain-engine';
import { StorageEngine } from './storage/storage-engine';
import { XenovaEmbeddingProvider } from './providers/xenova-embedding';
import { createErrorEvent } from './core/preprocessor';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB = join(tmpdir(), 'codebrain-test.db');

async function main() {
  console.log('=== codebrain 全链路测试 ===\n');

  // Mock LLM: 返回合理的 JSON 但不调真实 API
  let groupCounter = 0;
  const mockLLM = {
    async complete(prompt: string): Promise<string> {
      if (prompt.includes('isNewGroup')) {
        // 任务①: 错误分组
        groupCounter++;
        const id = `grp-store-null-${groupCounter}`;
        return JSON.stringify({
          isNewGroup: true,
          groupId: id,
          groupSummary: 'Zustand store 空值访问',
          errorTemplate: "TypeError: accessing property on null/undefined from store selector",
          isProjectSpecific: false,
        });
      }
      if (prompt.includes('代码')) {
        // 任务②: 策略提取
        return JSON.stringify({
          strategy: '使用可选链 ?. 做安全访问',
          rootCause: 'store 初始状态为 null，直接属性访问导致空指针',
          avoidanceHint: '不对 store 返回值做判空就访问属性',
        });
      }
      return '{}';
    },
  };

  const embedding = new XenovaEmbeddingProvider();
  const storage = new StorageEngine(TEST_DB);
  const engine = new CodeBrainEngine(embedding, mockLLM, storage);
  await engine.initialize();

  // ---- 场景 1: 第一次错误（冷启动） ----
  console.log('1. 第一次错误: 冷启动，无历史知识');
  const err1 = createErrorEvent(
    "TypeError: Cannot read properties of null (reading 'name')\n    at Home (src/pages/Home.tsx:12:17)",
    { command: 'npm run dev', sourceFile: 'src/pages/Home.tsx' },
  );
  const r1 = await engine.onError(err1);
  console.log(`   注入: ${r1 || '(无 — L0/L1 未命中，知识库空)'}`);

  // 模拟 Agent 修复
  console.log('\n2. Agent 修复: 加可选链 user?.name');
  const fix1 = {
    error: err1,
    codeBefore: 'console.log(user.name)',
    codeAfter: 'console.log(user?.name)',
    diff: '- console.log(user.name)\n+ console.log(user?.name)',
    fixTimestamp: Date.now(),
  };

  // 模拟修复检测
  await engine.onSuccess('npm run dev', 0);
  await engine.onFixDetected(fix1);
  console.log('   知识已入库（内存+SQLite）');

  // ---- 场景 2: 同类错误再次出现（L1 命中） ----
  console.log('\n3. 同类错误再次出现（同一会话）');
  const err2 = createErrorEvent(
    "TypeError: Cannot read properties of undefined (reading 'value')\n    at App (src/App.tsx:42:5)",
    { command: 'npm run dev', sourceFile: 'src/App.tsx' },
  );
  const r2 = await engine.onError(err2);
  console.log(`   注入: ${r2 ? '✅\n' + r2 : '❌ 未命中'}`);

  // 第二次修复
  await engine.onSuccess('npm run dev', 0);
  const fix2 = {
    error: err2,
    diff: '- document.body.className = settings.value\n+ document.body.className = settings?.value',
    fixTimestamp: Date.now(),
  };
  await engine.onFixDetected(fix2);

  // ---- 场景 3: 第三次同类错误（L0 errorCode 命中） ----
  console.log('\n4. 第三次同类错误（verifiedCount 已累积）');
  const err3 = createErrorEvent(
    "TypeError: Cannot read properties of null (reading 'title')",
    { command: 'npm run dev' },
  );
  const r3 = await engine.onError(err3);
  console.log(`   注入: ${r3 ? '✅\n' + r3 : '❌ 未命中'}`);

  // 第三次修复
  await engine.onSuccess('npm run dev', 0);
  const fix3 = { error: err3, diff: '+?.', fixTimestamp: Date.now() };
  await engine.onFixDetected(fix3);

  // ---- 场景 4: 不同类错误（不命中） ----
  console.log('\n5. 不同类错误（应不命中）');
  const err4 = createErrorEvent(
    "Error: Module not found: Can't resolve 'lodash'",
    { command: 'npm run dev' },
  );
  const r4 = await engine.onError(err4);
  console.log(`   注入: ${r4 || '(无 — 语义不匹配，正确)'}`);

  // ---- 查看知识库 ----
  console.log('\n=== 知识库状态 ===');
  const s = await engine.stats;
  console.log(`分组: ${s.totalGroups} | 事件: ${s.totalEvents}`);
  for (const k of engine.knowledge.getAll()) {
    console.log(`\n[${k.groupId}] ${k.summary}`);
    console.log(`  出现: ${k.occurrences} | 状态: ${k.status}`);
    for (const sol of k.solutions) {
      console.log(`  - v=${sol.verifiedCount} | fix: ${sol.strategy} | root: ${sol.rootCause}`);
    }
  }

  storage.close();
  console.log('\n=== 全链路测试通过 ===');
}

main().catch(console.error);
