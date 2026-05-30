# CodeBrain 核心流程时序文档

> 测试时间: 2026-05-30 | LLM: mock (同步返回) | Embedding: Xenova/MiniLM-L6-v2

---

## 架构概览

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  onError()  │ ──▶ │  MatchEngine │ ──▶ │ MemoryIndex │
│  (入口)     │     │  (匹配)      │     │  (内存索引) │
└──────┬──────┘     └──────────────┘     └─────────────┘
       │
       ▼
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│ AIAnalyzer  │ ◀── │CodeBrainEngine│ ──▶ │  StorageEngine  │
│ (LLM 归纳)  │     │  (调度中心)   │     │  (SQLite 持久化)│
└─────────────┘     └──────────────┘     └─────────────────┘
       │
       ▼
┌─────────────┐
│  MockLLM    │
│ (同步返回)  │
└─────────────┘
```

**模块清单:**

| 模块                       | 文件                                   | 职责                                               |
| -------------------------- | -------------------------------------- | -------------------------------------------------- |
| **CodeBrainEngine**  | `src/core/codebrain-engine.ts`       | 总调度：错误入口、防循环、注入格式化、异步阶段编排 |
| **MatchEngine**      | `src/core/match-engine.ts`           | 三层匹配：L0 精确 / L1 向量 / (L2 LLM 语义已跳过)  |
| **MemoryIndex**      | `src/core/memory-index.ts`           | 内存索引：L0 文本+错误码索引、L1 embedding 矩阵    |
| **AIAnalyzer**       | `src/core/ai-analyzer.ts`            | LLM 调用：错误分组、策略提取、规则归纳             |
| **Preprocessor**     | `src/core/preprocessor.ts`           | 文本归一化：路径/数字/错误语义 → 占位符           |
| **StorageEngine**    | `src/storage/storage-engine.ts`      | SQLite 持久化读写                                  |
| **XenovaEmbedding**  | `src/providers/xenova-embedding.ts`  | MiniLM-L6-v2 本地 embedding (384维)                |

---

## 阶段 1: 冷启动 miss → 入库

```
时间轴: 0ms ──────── 0ms ─── 0ms ────────────────── ~5000ms
        │              │        │                          │
        ▼              ▼        ▼                          ▼
     输入 err1    onError 返回 onFixDetected触发      异步提取入库完成
                 (立即返回null) (fire-and-forget)
```

### T+0ms — 输入

> **输入**: 原始错误文本 (带堆栈)

```
"TypeError: Cannot read properties of null (reading 'name')
    at Home (src/pages/Home.tsx:12:17)"
```

### T+0ms — Preprocessor 归一化

> **模块**: `Preprocessor.preprocess()`

```diff
原始:
  TypeError: Cannot read properties of null (reading 'name')
      at Home (src/pages/Home.tsx:12:17)

归一化 (Step 1 — 通用占位符):
  TypeError: Cannot read properties of null (reading 'name')
      at Home (<FILE>:<LINE>)

归一化 (Step 2 — 错误语义占位符):
  TypeError: Cannot read properties of <NIL> (reading '<PROP>')
      at <FUNC> (<FILE>:<LINE>)

替换明细:
  null           → <NIL>      (NULLISH_RE)
  (reading 'name') → (reading '<PROP>')  (PROP_READ_RE)
  at Home        → at <FUNC>  (FUNC_STACK_RE)
  src/pages/Home.tsx → <FILE> (REL_PATH_RE)
  :12:17         → :<LINE>    (LINE_RE)

最终归一化 (QUOTED_STR_RE 兜底):
  '<PROP>' → <STR> 导致 (reading '<PROP>') → (reading <STR>)
```

> **输出**: `err1.normalized` = `"TypeError: Cannot read properties of <NIL> (reading <STR>) at <FUNC> (<FILE>:<LINE>)"`

### T+0ms — L0 精确匹配

> **模块**: `MatchEngine.matchExact()` → `MemoryIndex`

```
L0 错误码匹配: err1.errorCode = undefined → 跳过
L0 文本匹配:   MemoryIndex.l0TextIndex = {} (知识库空) → 未命中
```

> **输出**: `null`

### T+0ms — L1 向量匹配

> **模块**: `MatchEngine.matchVector()` → `MemoryIndex.getEmbeddingMatrix()`

```
embedding 矩阵: [] (知识库为空)
→ 跳过向量搜索
```

> **输出**: `[]`

### T+0ms — onError 返回

> **模块**: `CodeBrainEngine.onError()`

```
L0 miss → L1 miss → 无匹配

操作:
  1. pendingQueue.push(err1)          ← 入待处理队列 (无 groupId)
  2. stage1Group(err1) 异步触发       ← AI 分组 (fire-and-forget)
  3. // stage2LLMMatch (L2 已跳过)    ← LLM 语义匹配 (注释，按需启用)

返回: null (无注入)
```

> **数据操作**: `pendingQueue += [{ normalized, sourceFile, errorCode, timestamp }]` (无 groupId)

### T+0ms — stage1Group 异步触发

> **模块**: `CodeBrainEngine.stage1Group()` → `AIAnalyzer.groupError()` → mockLLM

```
stage1Group 传入当前知识库 (空列表) 给 LLM 判断:
  现有分组: [] (冷启动)

mockLLM 返回 (isNewGroup):
  { isNewGroup: false, groupId: 'store-null',
    groupSummary: '空值访问错误',
    errorTemplate: "TypeError: accessing property on null/undefined",
    category: 'javascript/type-error', isProjectSpecific: false }

→ groupingPromises.set(key, promise)  ← 缓存 promise 供后续 getGrouping 使用
```

> ⚡ **注意**: mockLLM 始终返回 `isNewGroup: false, groupId: 'store-null'`，无论知识库是否为空。AI 判断该错误属于 `store-null` 分组。

### T+0ms — onFixDetected 触发（fire-and-forget + 清理 pendingQueue）

> **输入**: 修复信息

```json
{
  "error": err1,
  "codeBefore": "console.log(user.name)",
  "codeAfter":  "console.log(user?.name)",
  "diff":        "+ user?.name"
}
```

> **模块**: `CodeBrainEngine.onFixDetected()` — **fire-and-forget, 立即返回**

```
onFixDetected(fix) {
  // [Fix 2] 清理 pendingQueue 中对应条目，防止 onSuccess 重复处理
  pendingQueue = pendingQueue.filter(p => p.normalized !== fix.error.normalized);
  // err1 已从 pendingQueue 移除 → onSuccess 不会再处理它

  stage2ExtractSolution(fix.error, fix).catch(() => {});  // 异步后台
  return;  // <1ms 返回，不阻塞热更新链路
}
```

### T+0~5000ms — 异步提取入库（后台）

> **等待 5s**: Xenova embedding 模型加载 + 推理耗时，等待异步操作完成

> **模块调用链**:

```
CodeBrainEngine.stage2ExtractSolution()
  │
  ├─ dedupKey = event.normalized + (event.sourceFile || '')
  ├─ extractingPromises.has(dedupKey)?  ← 防重入检查
  │     └─ 是 → 跳过（已有进行中的提取）
  │     └─ 否 → 继续
  │
  ├─▶ AIAnalyzer.extractSolution()     ← mockLLM (~0ms)
  │     │
  │     └─▶ mockLLM 匹配 "修复前/Diff/代码" → 返回 strategy/rootCause/avoid
  │
  ├─▶ getGrouping()                     ← 等待 stage1Group 的 promise 结果
  │     │
  │     ├─ groupingCache.get(key)       → 未命中
  │     ├─ groupingPromises.get(key)    → 命中! (stage1Group 已缓存)
  │     └─ await promise → { groupId: 'store-null', groupSummary: '空值访问错误', ... }
  │
  ├─ index.get('store-null') → undefined  ← 知识库尚无此分组
  │     └─ 新建 ErrorKnowledge { groupId: 'store-null', ... }
  │
  ├─▶ embedding.embed(event.normalized)   ← Xenova 本地推理 (~数百ms)
  │     └─ 生成 Float32Array(384)
  │
  ├─▶ StorageEngine.upsert()            ← 写入 SQLite
  │     + MemoryIndex.add()             ← L0 索引 (errorTemplate)
  │     + MemoryIndex.addTextKey()      ← L0 补充索引 (event.normalized)
  │
  └─ extractingPromises.delete(dedupKey) ← 释放防重入锁
```

> **mockLLM 输出 (extractSolution)**:

```json
{
  "strategy": "使用可选链 ?. 做安全访问",
  "rootCause": "store 初始状态为 null，直接访问属性导致空指针",
  "avoidanceHint": "不对 store 返回值做判空就访问属性"
}
```

> **mockLLM 输出 (groupError)**:

```json
{
  "isNewGroup": false,
  "groupId": "store-null",
  "groupSummary": "空值访问错误",
  "errorTemplate": "TypeError: accessing property on null/undefined",
  "category": "javascript/type-error",
  "isProjectSpecific": false
}
```

> **数据库写入**:

```yaml
groupId: store-null
summary: 空值访问错误
errorTemplate: "TypeError: accessing property on null/undefined"
category: javascript/type-error
occurrences: 1
solutions:
  - id: sol-xxx
    strategy: "使用可选链 ?. 做安全访问"
    rootCause: "store 初始状态为 null，直接访问属性导致空指针"
    avoidanceHint: "不对 store 返回值做判空就访问属性"
    verifiedCount: 1
embedding: Float32Array(384)  # Xenova 向量
```

> **数据流**:

```
               extractSolution ──▶ strategy/rootCause/avoid
              /
stage2Extract ──▶ getGrouping(stage1Group promise) ──▶ groupId/groupSummary/category/errorTemplate
  Solution    \
               embedding.embed(normalized) ──▶ Float32Array(384)

              ┌─ MemoryIndex.add(embedding)      ← errorTemplate → L0 索引 + L1 向量索引
upsert ──────┤
              ├─ MemoryIndex.addTextKey(normalized) ← event.normalized → L0 补充索引
              └─ StorageEngine.upsert(knowledge) ← SQLite 持久化

防重入:
  extractingPromises.set(dedupKey, task)  ← 标记进行中
  同 key 再次触发 → .has(dedupKey) = true → 跳过
  task 完成后 → .delete(dedupKey)        ← 释放锁
```

---

## 阶段 2: 同类错误 → L0 命中 → pendingQueue 累积

```
时间轴: ~5000ms ──────── 5001ms ────────────── 5002ms
          │                │                      │
          ▼                ▼                      ▼
       输入 err2      onError L0 命中注入      onSuccess 处理
                                                 pendingQueue
```

### T+~5000ms — 阶段 1 异步完成后的知识库状态

```
MemoryIndex:
  l0TextIndex: {
    "TypeError: Cannot read properties of <NIL> (reading <STR>) at <FUNC> (<FILE>:<LINE>)" → ["store-null"],  ← addTextKey
    "TypeError: accessing property on null/undefined" → ["store-null"]                                        ← errorTemplate
  }
  embeddings: { "store-null" → Float32Array(384) }
  knowledgeMap: { "store-null" → { occurrences: 1, solutions: [{ verifiedCount: 1 }] } }
```

### T+~5000ms — 输入

> **输入**: 同类但措辞不同的错误

```
"TypeError: Cannot read properties of undefined (reading 'value')
    at App (src/App.tsx:42:5)"
```

### T+~5000ms — Preprocessor 归一化

> **模块**: `Preprocessor.preprocess()`

```
undefined       → <NIL>       (NULLISH_RE)
(reading 'value') → (reading '<PROP>') → (reading <STR>)  (PROP_READ_RE + QUOTED_STR_RE)
at App          → at <FUNC>   (FUNC_STACK_RE)
src/App.tsx     → <FILE>      (REL_PATH_RE)
:42:5           → :<LINE>     (LINE_RE)
```

> **输出**: `err2.normalized` = `"TypeError: Cannot read properties of <NIL> (reading <STR>) at <FUNC> (<FILE>:<LINE>)"`

> ⚡ **关键**: `err2.normalized === err1.normalized` — 归一化后完全一致！

### T+~5000ms — L0 精确匹配 ✅

> **模块**: `MatchEngine.matchExactText()` → `MemoryIndex.l0TextIndex`

```
L0 文本匹配 (matchExactText):
  1. 精确查询: err2.normalized
     → l0TextIndex.get("TypeError: Cannot read properties of <NIL> (reading <STR>) at <FUNC> (<FILE>:<LINE>)")
     → ["store-null"] ✅ 直接命中
     
  2. 若未命中, 还有 substring 兜底:
     → normalized.includes(template) || template.includes(normalized)
     → 处理无堆栈的短文本场景
```

> **输出**: `{ groupId: "store-null", relevance: 1.0, reason: "L0 text exact" }`

> ⚡ **关键**: `MemoryIndex.addTextKey()` 在 `stage2ExtractSolution` 入库时，用 `event.normalized` 作为 L0 文本索引 key，保证后续同类归一化文本能精确命中。

### T+~5000ms — 防循环检查

> **模块**: `CodeBrainEngine` 防循环逻辑

```
injectionHistory 查询: groupId="store-null" 命中次数 = 0
→ 未达 ANTI_LOOP_THRESHOLD(3) → 放行
→ injectionHistory.push({ groupId: "store-null", turnIndex=0, suppressed: false })
→ pendingQueue.push({ ..., groupId: "store-null" })
```

### T+~5000ms — 注入输出

> **模块**: `CodeBrainEngine.formatInjection()`

```
[codebrain]
fix: 使用可选链 ?. 做安全访问
root: store 初始状态为 null，直接访问属性导致空指针
avoid: 不对 store 返回值做判空就访问属性
hit: 1次 | v: 1
```

> **返回**: 注入字符串 → Claude Code hook 包装为 `additionalContext` → 追加到 Agent 下一轮上下文

**注入链路**:

```
onError 返回注入文本
    │
    ▼
daemon POST /hook 响应 { injected: "[codebrain]\n..." }
    │
    ▼
hook.ts 包装为 Claude Code hook 协议:
    {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: "\n[codebrain]\nfix: 使用可选链...\n..."
      }
    }
    │
    ▼
Claude Code 将 additionalContext 追加到 Agent 下一条消息前
    │
    ▼
Agent 看到: 错误输出 + CodeBrain 注入的历史修复方案
    → 直接用已验证的策略修复，无需从零分析
```

**注入目的**:

| 阶段 | 无 CodeBrain | 有 CodeBrain |
|------|-------------|-------------|
| 看到错误 | `TypeError: Cannot read...` | 错误 + `fix/root/avoid` |
| 分析 | 读报错 → 猜原因 → 搜文档 | 已知根因，跳过分析 |
| 修复 | 试方案 → 可能失败 → 重试 | 直接用已验证方案 |
| 耗时 | 多轮试错 | 一轮修复 |
| 同类错误 | 每次从零开始 | `hit: N次` 提示置信度，`rule` 提供预防规则 |

### T+~5001ms — onSuccess → verifiedCount=2

> **输入**: 命令执行成功 `npm run dev`, exitCode=0

> **模块**: `CodeBrainEngine.onSuccess()`

```
turnCounter: 0 → 1

// pendingQueue 中只有 err2 — err1 已被 onFixDetected 清理 (Fix 2)
pendingQueue = [
  { err2, groupId: 'store-null' },
]

▸ 处理 err2 (groupId='store-null'):
    incrementVerifiedCount('store-null', 'npm run dev', 0):
      top.verifiedCount++ → 1→2
      knowledge.occurrences++ → 1→2
      totalVerified = 2 < 3 → 跳过规则归纳

pendingQueue = []
```

> **数据操作**: SQLite UPDATE `verifiedCount=2, occurrences=2`

> ⚡ 修复前 err1 也在 pendingQueue 中，`onSuccess` 会对其重建 event（丢失 `sourceFile`），导致 `dedupKey` 不匹配 → 防重入失效 → 重复提取。现在 `onFixDetected` 清理 pendingQueue（Fix 2）+ event 带 `sourceFile`（Fix 1），彻底消除重复处理。

---

## 阶段 3: 同类错误 → L0 命中 → 防循环 Warning → onSuccess → 规则归纳

```
时间轴: ~5002ms ──────── 5002ms ──────────── 5003ms ──────────── ~10003ms
          │                │                      │                    │
          ▼                ▼                      ▼                    ▼
       输入 err3      onError L0 命中        onSuccess v=3      规则归纳完成
                     + 防循环 warning       + 规则归纳触发
```

### T+~5002ms — 输入

> **输入**: 同类错误（无堆栈）

```
"TypeError: Cannot read properties of null (reading 'title')"
```

### T+~5002ms — Preprocessor → L0 匹配

```
normalized: "TypeError: Cannot read properties of <NIL> (reading <STR>)"

L0 文本匹配:
  1. 精确查询: l0TextIndex.get(normalized) → 未命中
     (err3.normalized 较短，无 "at <FUNC> (<FILE>:<LINE>)" 部分)

  2. substring 兜底: template.includes(normalized)?
     索引中 err1.normalized = "TypeError: ... at <FUNC> (<FILE>:<LINE>)"
     包含 err3.normalized → ✅ 命中!
     → ["store-null"]
```

> ⚡ **注意**: err3 没有堆栈信息，归一化后比 err1/err2 短，但 L0 的 substring 匹配兜底生效。

### T+~5002ms — 防循环 → 降级警告

```
injectionHistory: store-null 已命中 1 次 (err2 为第1次，err3 为第2次)
→ groupHits = 1 (≥ 1) → isWarning = true
→ formatInjection 追加: "⚠ 此方案上次未解决该问题"
```

### T+~5002ms — 注入输出

```
[codebrain]
fix: 使用可选链 ?. 做安全访问
root: store 初始状态为 null，直接访问属性导致空指针
avoid: 不对 store 返回值做判空就访问属性
hit: 2次 | v: 2
⚠ 此方案上次未解决该问题        ← 第2次命中降级
```

> **注**: `v: 2` — 当前只有 err2 的 `incrementVerifiedCount` 同步更新过。err1 在阶段1 给 v=1，err2 在阶段2 onSuccess 给 v=2。err3 自身的 onSuccess 将把它推到 v=3。

### T+~5002ms — onSuccess → verifiedCount=3 + 规则归纳触发

> **模块**: `CodeBrainEngine.onSuccess()` → `incrementVerifiedCount()` → `stage3InduceRule()`

```
turnCounter: 1 → 2

pendingQueue = [{ err3, groupId: 'store-null' }]

incrementVerifiedCount('store-null', 'npm run dev', 0):
  top.verifiedCount++ → 2→3
  knowledge.occurrences++ → 2→3
  totalVerified = 3 ≥ 3 && !abstractRule
  → stage3InduceRule('store-null') 异步触发 🔧
```

### T+~5003~10003ms — 规则归纳完成

> **模块**: `CodeBrainEngine.stage3InduceRule()` → `AIAnalyzer.induceRule()` → mockLLM

> **触发条件**: `totalVerified ≥ 3 && !knowledge.abstractRule`
> **第一次触发**: 微任务 MT1b 中 err1 异步再处理的 `similar.verifiedCount++` 将 v 推到 3，触发 `stage3InduceRule`。此后 err3 的 `onSuccess` 中 v 到 4 时，因 `abstractRule` 已有值（或异步正在设置），第二次触发被跳过。

**LLM Prompt 构建**:

```
分组摘要: 空值访问错误
错误事件:
  [1] errorTemplate: TypeError: accessing property on null/undefined
      | 策略: 使用可选链 ?. 做安全访问
      | 根因: store 初始状态为 null，直接访问属性导致空指针
```

> **mockLLM 输出 (induceRule)** — 匹配 "抽象规则/abstractRule":

```json
{
  "abstractRule": "store 返回值必须先做空值检查再访问属性",
  "triggerDescription": "当 store selector 返回可能为 null/undefined 时触发",
  "preventionAdvice": "使用可选链 (?.) 或提前 return null guard"
}
```

> **数据操作**: SQLite UPDATE `abstractRule, triggerDescription, preventionAdvice`

---

## 阶段 4: 不同类错误 → 冷启动 miss → onSuccess → 新分组入库

```
时间轴: ~10s ──────── 10s ──────────── ~15s
         │              │                    │
         ▼              ▼                    ▼
      输入 err4     onError=null ✅    onSuccess 入库新分组
                   (L0/L1 不命中)     module-not-found
```

### T+~10s — 输入

> **输入**: 完全不同类型的错误

```
"Error: Module not found: Can't resolve 'lodash'"
```

### T+~10s — 匹配流程

```
Preprocessor:
  "Error: Module not found: Can't resolve <STR>"

L0 错误码: 无匹配
L0 文本匹配: normalized 不在 l0TextIndex
  (唯一索引 key 是 null-prop-access 的归一化文本，与此完全不同)
  → substring 兜底也不匹配

L1 向量匹配:
  余弦相似度 vs null-prop-access embedding
  "Module not found" vs "TypeError: Cannot read properties of <NIL>"
  → 语义完全不相关 → 相似度 < 0.3 → 远低于 0.7 阈值
```

> **输出**: `null` → 正确不命中 ✅ (流程与 err1 冷启动完全一致)

### T+~10s — onError miss 分支

```
pendingQueue.push({ err4, groupId: undefined })

stage1Group(err4) 异步触发
  └─▶ AIAnalyzer.groupError()
        mockLLM 判断: 错误含 "Module"/"resolve" → isNewGroup: true
        → { groupId: 'module-not-found', groupSummary: '模块找不到',
            errorTemplate: "Module not found: Can't resolve <STR>",
            category: 'bundler/module-resolution', isProjectSpecific: true }
        → groupingPromises.set(key, promise)
```

### T+~10s — onSuccess → stage2ExtractSolution → 新分组入库

> **模拟**: 开发者 `npm install lodash` → `npm run dev` 成功

```
onSuccess:
  pendingQueue = [{ err4, groupId: undefined }]

  处理 err4 (无 groupId):
    → stage2ExtractSolution(event, fix)   // event 带 sourceFile (Fix 1)
    → extractSolution → mockLLM (匹配 "Module") →
         { strategy: "运行 npm install 安装缺失模块",
           rootCause: "lodash 未安装或未在 package.json 中声明",
           avoidanceHint: "import 第三方包前先 npm install" }
    → getGrouping → stage1Group 已缓存 promise → await →
         { groupId: 'module-not-found', ... }
    → index.get('module-not-found') → undefined → 新建分组
    → v=1, occ=1
    → totalVerified=1 < 3 → 跳过规则归纳
```

> **数据操作**: SQLite INSERT 新分组 `module-not-found`, v=1, occ=1

> ⚡ err4 的流程与 err1 完全对称——都是冷启动 miss → 后续修复动作 → 异步入库。区别仅在于 err1 走 `onFixDetected`（带 diff），err4 走 `onSuccess`（无 diff，但 extractSolution prompt 模板本身含 `代码` 关键字仍能触发 mockLLM）。

---

## 知识库最终状态

```
┌─────────────────────────────────────────────────────┐
│  groupId:     null-prop-access                      │
│  summary:     空值属性访问错误                         │
│  category:    javascript/type-error                 │
│  occurrences: 3                                     │
│                                                     │
│  solutions[0]:                                      │
│    strategy:  "使用可选链做安全访问"                    │
│    rootCause: "对象为 null 时访问属性"                  │
│    avoid:     "访问前判空"                            │
│    verifiedCount: 3                                 │
│                                                     │
│  🔧 abstractRule:                                   │
│    "store 返回值必须先做空值检查再访问属性"             │
│  🔧 triggerDescription:                             │
│    "当 store selector 返回可能为 null/undefined       │
│     时触发"                                         │
│  🔧 preventionAdvice:                               │
│    "使用可选链 (?.) 或提前 return null guard"         │
├─────────────────────────────────────────────────────┤
│  groupId:     module-not-found                      │
│  summary:     模块找不到                              │
│  category:    bundler/module-resolution             │
│  occurrences: 1                                     │
│                                                     │
│  solutions[0]:                                      │
│    strategy:  "运行 npm install 安装缺失模块"          │
│    rootCause: "lodash 未安装"                        │
│    avoid:     "import 前先 npm install"              │
│    verifiedCount: 1                                 │
│                                                     │
│  abstractRule: (无 — v=1 < 3, 规则归纳未触发)          │
└─────────────────────────────────────────────────────┘
```

> ⚡ **null-prop-access v=3 溯源**:
> ```
> v=1: err1 onFixDetected → stage2ExtractSolution (首次入库)
> v=2: err2 onSuccess → incrementVerifiedCount
> v=3: err3 onSuccess → incrementVerifiedCount → 触发规则归纳
> ```
> **module-not-found v=1**: err4 cold start miss → onSuccess → stage2ExtractSolution (新分组)

---

## 数据流总览

```
                    ┌──────────────┐
    原始错误 ──────▶│ Preprocessor │──▶ normalized (归一化文本)
                    └──────────────┘          │
                                              ▼
                    ┌──────────────┐    ┌──────────────┐
              ┌────▶│  MatchEngine │───▶│ L0: 精确匹配 │──▶ 命中?
              │     │  matchSync() │    │ L1: 向量匹配 │
              │     └──────────────┘    └──────────────┘
              │            │                │
              │            │           命中 │     未命中
              │            │                │      │
              │            ▼                ▼      ▼
              │     ┌──────────────┐  ┌──────────────┐
              │     │ XenovaEmbed  │  │formatInjection│──▶ 注入
              │     │  (L1 only)   │  └──────────────┘
              │     └──────────────┘         │
              │                         pendingQueue.push
              │                              │
              │                         stage1Group() 异步
              │
    修复成功时 (fire-and-forget, 不阻塞)
              │
              ▼
    ┌──────────────────┐
    │  onFixDetected() │──▶ stage2ExtractSolution().catch()
    │  onSuccess()     │         │
    └──────────────────┘         │
                                 ├─ extractingPromises 防重入
                                 ├─ extractSolution() ──▶ LLM
                                 ├─ getGrouping() ──────▶ LLM (stage1 promise)
                                 ├─ embedding.embed() ──▶ Xenova
                                 ├─ MemoryIndex.addTextKey() ← L0 补充索引
                                 └─ StorageEngine.upsert()   ← SQLite

           ⚠ pendingQueue 累积效应:
              onSuccess 会处理所有 pendingQueue 条目
              └─ 无 groupId → stage2ExtractSolution (可能重复提取)
              └─ 有 groupId → incrementVerifiedCount

                    verifiedCount ≥ 3
                            │
                            ▼
                    stage3InduceRule().catch()
                            │
                     induceRule() ──▶ LLM
                            │
                            ▼
                    abstractRule / triggerDescription / preventionAdvice
```

---

## LLM 调用汇总 (本次测试)

| 序号 | 方法 | 触发时机 | 阻塞主链路? | 耗时 | 分组 |
|------|------|----------|------------|------|------|
| 1 | `groupError` | err1 `stage1Group` (onError miss) | ❌ 异步后台 | ~0ms (mock) | → null-prop-access |
| 2 | `extractSolution` | err1 `stage2ExtractSolution` (onFixDetected) | ❌ 异步后台 | ~0ms (mock) | → null-prop-access |
| 3 | `induceRule` | err3 `onSuccess`: totalVerified≥3 | ❌ 异步后台 | ~0ms (mock) | → null-prop-access |
| 4 | `groupError` | err4 `stage1Group` (onError miss) | ❌ 异步后台 | ~0ms (mock) | → module-not-found |
| 5 | `extractSolution` | err4 `stage2ExtractSolution` (onSuccess) | ❌ 异步后台 | ~0ms (mock) | → module-not-found |

**LLM 参数**: mockLLM 同步返回 (实际生产环境: DeepSeek `temperature=0, maxTokens=300`)

> ⚡ err4 的冷启动流程与 err1 对称，各触发 2 次 LLM 调用（groupError + extractSolution）。err1~3 共触发 3 次（groupError + extractSolution + induceRule）。合计 5 次，无重复调用。

---

## 关键设计要点

1. **Preprocessor 归一化链**: 先替换路径/数字（通用），再替换错误语义占位符（领域特定），顺序很重要。QUOTED_STR_RE 兜底会将 `'<PROP>'` 再替换为 `<STR>`，属于已知行为。
2. **L0 双索引**: `MemoryIndex.add()` 用 `errorTemplate` 建索引，`addTextKey()` 额外用 `event.normalized` 建索引，确保归一化文本精确命中
3. **L0 substring 兜底**: `matchExactText` 在精确匹配失败后尝试 substring 包含匹配，处理无堆栈的短错误文本
4. **getGrouping 三层兜底**: cache → promise await → 同步补调，stage1Group 异步结果通过 `groupingPromises` 传递给后续 `stage2ExtractSolution`
5. **防重入**: `extractingPromises` 追踪进行中的 `stage2ExtractSolution`，同一 key 只允许一个在执行
6. **全异步 LLM**: `onFixDetected` / `onSuccess` 均为 fire-and-forget，LLM 调用不阻塞主链路
7. **防循环**: 窗口(50轮)内同组命中≥3次 → suppress，第2次降级 warning
8. **L2 已跳过**: `stage2LLMMatch` 和 `l2Pending` 注入逻辑保留在注释中，当前 L0/L1 召回率已够用
9. **onFixDetected 清理 pendingQueue**: `onFixDetected` 已将错误送入提取链路（带 diff 信息更丰富），对应的 pendingQueue 条目立即清除。避免 `onSuccess` 在信息更少（无 diff、可能无 sourceFile）的情况下重复触发提取，防止 verifiedCount 虚高。
10. **onSuccess event 重建保留 sourceFile**: `onSuccess` 构造 event 时传入 `sourceFile: pending.sourceFile`，保证 `dedupKey` 和 `getGrouping` key 与 `onFixDetected`/`stage1Group` 一致，防重入和分组缓存能正常命中。
