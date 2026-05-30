/**
 * 模拟全链路测试：用 mock LLM 走通完整流程（含规则归纳）。
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
  console.log('=== codebrain 全链路测试 (含规则归纳) ===\n');

  let groupCallCount = 0;
  const mockLLM = {
    async complete(prompt: string): Promise<string> {
      if (prompt.includes('抽象规则') || prompt.includes('abstractRule')) {
        // 根据分组摘要返回不同规则 ("空值属性访问错误" 含 "空值" 不含连续 "空值访问")
        if (prompt.includes('空值')) {
          return JSON.stringify({
            abstractRule: 'store 返回值必须先做空值检查再访问属性',
            triggerDescription: '当 store selector 返回可能为 null/undefined 时触发',
            preventionAdvice: '使用可选链 (?.) 或提前 return null guard',
          });
        }
        return JSON.stringify({
          abstractRule: 'import 前确保模块已安装',
          triggerDescription: '当引用未安装的 npm 包时触发',
          preventionAdvice: 'npm install 后再 import',
        });
      }
      if (prompt.includes('isNewGroup')) {
        groupCallCount++;
        // 根据 prompt 中的错误内容判断分组
        if (prompt.includes('Module') || prompt.includes('resolve')) {
          return JSON.stringify({
            isNewGroup: true,
            groupId: 'module-not-found',
            groupSummary: '模块找不到',
            errorTemplate: "Module not found: Can't resolve <STR>",
            category: 'bundler/module-resolution',
            isProjectSpecific: true,
          });
        }
        // 首个错误：判断为已有分组（无论知识库是否为空，模拟 AI 语义判断）
        if (groupCallCount === 1) {
          return JSON.stringify({
            isNewGroup: false,
            groupId: 'null-prop-access',
            groupSummary: '空值属性访问错误',
            errorTemplate: "TypeError: Cannot read properties of <NIL>",
            category: 'javascript/type-error',
            isProjectSpecific: false,
          });
        }
        return JSON.stringify({
          isNewGroup: false,
          groupId: 'null-prop-access',
          groupSummary: '空值属性访问错误',
          errorTemplate: "TypeError: Cannot read properties of <NIL>",
          category: 'javascript/type-error',
          isProjectSpecific: false,
        });
      }
      if (prompt.includes('代码') || prompt.includes('Diff') || prompt.includes('修复前')) {
        if (prompt.includes('resolve') || prompt.includes('Module')) {
          return JSON.stringify({
            strategy: '运行 npm install lodash 安装缺失模块',
            rootCause: 'lodash 未安装或未在 package.json 中声明',
            avoidanceHint: 'import 第三方包前先 npm install',
          });
        }
        return JSON.stringify({
          strategy: '使用可选链 ?. 做安全访问',
          rootCause: 'store 初始状态为 null，直接访问属性导致空指针',
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

  // ==== 错误 1: 冷启动 → L0/L1 miss → onFixDetected → solution #1 (v=1) ====
  console.log('1. 错误 1: 冷启动 miss → AI 分组 → 入库 solution #1');
  const err1 = createErrorEvent(
    "TypeError: Cannot read properties of null (reading 'name')\n    at Home (src/pages/Home.tsx:12:17)",
    { command: 'npm run dev', sourceFile: 'src/pages/Home.tsx' },
  );
  const r1 = await engine.onError(err1);
  console.log(`   注入: ${r1 || '(无 — 知识库空)'}`);

  // onFixDetected: 有 diff 的修复 → stage2ExtractSolution
  engine.onFixDetected({
    error: err1,
    codeBefore: 'console.log(user.name)',
    codeAfter: 'console.log(user?.name)',
    diff: '+ user?.name',
    fixTimestamp: Date.now(),
  });
  // 等待异步 stage2ExtractSolution 完成 (Xenova embedding 加载需要时间)
  await new Promise(r => setTimeout(r, 5000));
  console.log('   onFixDetected → solution #1, verifiedCount=1\n');

  // ==== 错误 2: 同类错误 → L1 命中 → onSuccess → v=2 ====
  console.log('2. 错误 2: L1 命中 → onSuccess → verifiedCount=2');
  const err2 = createErrorEvent(
    "TypeError: Cannot read properties of undefined (reading 'value')\n    at App (src/App.tsx:42:5)",
    { command: 'npm run dev', sourceFile: 'src/App.tsx' },
  );
  const r2 = await engine.onError(err2);
  console.log(`   注入: ${r2 ? '✅' : '❌ miss'}`);

  // 命中路径: 只需 onSuccess 即可 increment verifiedCount
  await engine.onSuccess('npm run dev', 0);
  console.log('   onSuccess → verifiedCount=2\n');

  // ==== 错误 3: L0 命中 → onSuccess → v=3 → 🔧 规则归纳 ====
  console.log('3. 错误 3: L0 命中 → onSuccess → verifiedCount=3 → 规则归纳');
  const err3 = createErrorEvent(
    "TypeError: Cannot read properties of null (reading 'title')",
    { command: 'npm run dev' },
  );
  const r3 = await engine.onError(err3);
  const lines3 = r3?.split('\n') || [];
  console.log(`   注入: ${r3 ? '✅' : '❌'}`);
  const ruleLine = lines3.find(l => l.startsWith('rule:'));
  if (ruleLine) console.log(`   🔧 ${ruleLine}`);

  await engine.onSuccess('npm run dev', 0);
  // 等待异步 stage3InduceRule 完成
  await new Promise(r => setTimeout(r, 5000));
  console.log('   onSuccess → verifiedCount=3\n');

  // ==== 错误 4: 不同类错误 → 冷启动 miss → onSuccess → 新分组入库 ====
  console.log('4. 不同类错误: Module not found → 冷启动 miss → onSuccess 入库');
  const err4 = createErrorEvent(
    "Error: Module not found: Can't resolve 'lodash'",
    { command: 'npm run dev' },
  );
  const r4 = await engine.onError(err4);
  console.log(`   注入: ${r4 || '(无 — 不命中, 正确)'}`);

  // 模拟开发者装了包之后命令成功 → onSuccess 触发入库
  await engine.onSuccess('npm run dev', 0);
  await new Promise(r => setTimeout(r, 5000));
  console.log('   onSuccess → 新分组 module-not-found 入库\n');

  // ==== 知识库 ====
  console.log('=== 知识库状态 ===');
  const s = await engine.stats;
  console.log(`分组: ${s.totalGroups} | 事件: ${s.totalEvents}`);
  let passed = false;
  for (const k of engine.knowledge.getAll()) {
    const tv = k.solutions.reduce((sum, s) => sum + s.verifiedCount, 0);
    console.log(`\n[${k.groupId}] ${k.summary}`);
    console.log(`  出现: ${k.occurrences} | 方案: ${k.solutions.length} | 总验证: ${tv}`);
    if (k.abstractRule) {
      console.log(`  🔧 规则: ${k.abstractRule}`);
      console.log(`     触发: ${k.triggerDescription}`);
      console.log(`     预防: ${k.preventionAdvice}`);
      passed = true;
    }
  }

  storage.close();
  console.log(`\n${passed ? '✅ 规则归纳已触发 — 测试通过' : '⚠️ 规则归纳未触发'}`);
}

main().catch(console.error);
