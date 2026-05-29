# 单例流程 —— Zustand Store 类型错误

## 场景设定

- 项目：Next.js + TypeScript + Zustand
- 系统：Windows 11
- 工具：VSCode + Claude Code (DeepSeek)
- 全局框架：`codebrain` 已安装，Claude Code 适配器已配置

---

## 第 1 步：AI 生成代码

开发者对 Claude Code 说：

> "加一个 useUserStore，存用户信息和登录状态"

Claude Code 生成 `src/stores/user.ts`：

```typescript
import { create } from 'zustand';

interface UserState {
  user: { name: string; email: string } | null;
  setUser: (user: { name: string; email: string }) => void;
}

export const useUserStore = create<UserState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
}));
```

Claude Code 顺便在组件 `src/pages/Home.tsx` 中使用：

```typescript
const user = useUserStore((s) => s.user);
console.log(user.name); // AI 忘了判空
```

---

## 第 2 步：终端报错

Claude Code 运行 `npm run dev`，终端输出：

```
Type 'null' is not assignable to type '{ name: string; email: string; }'.
  at src/pages/Home.tsx:12:17
  
TypeError: Cannot read properties of null (reading 'name')
  at Home (src/pages/Home.tsx:12:17)
```

---

## 第 3 步：Agent 适配器提取错误

Claude Code 的 `PostToolUse` hook 触发。适配器从会话上下文中拿到：

```typescript
// Agent 适配器 extractErrors()
{
  raw: "Type 'null' is not assignable to type ... \nTypeError: Cannot read properties of null ...",
  command: "npm run dev",
  os: "win32",
  sourceFile: "src/pages/Home.tsx",
  // 错误发生前的代码（从会话上下文获取）
  codeBefore: "const user = useUserStore((s) => s.user);\nconsole.log(user.name);",
  timestamp: 1717000000000,
  sessionId: "session-abc-123"
}
```

---

## 第 4 步：算法预处理

```
raw → normalized:
  - 去 ANSI: (无，终端无颜色)
  - 剥离路径: "at src/pages/Home.tsx:12:17" → "at <FILE>:<LINE>"
  - 剥离行号: 12 → <LINE>
  - 提取错误码: TS2322
  - 堆栈截断: 只保留项目内帧

输出 ErrorEvent:
{
  raw: "Type 'null' is not assignable to type...\nTypeError: Cannot read properties of null...",
  normalized: "Type '<ID>' is not assignable to type '<ID>'. TypeError: Cannot read properties of null (reading '<ID>') at <FUNC> (<FILE>:<LINE>)",
  errorCode: "TS2322",
  command: "npm run dev",
  os: "win32",
  sourceFile: "src/pages/Home.tsx",
  codeSnippet: "const user = useUserStore((s) => s.user);\nconsole.log(user.name);",
  timestamp: 1717000000000,
  sessionId: "session-abc-123"
}
```

---

## 第 5 步：快路径 L0/L1 匹配（< 5ms，纯本地）

```
L0 精确匹配:
  错误码 TS2322 → l0Index 查哈希表 → 空（首次）
  normalized 文本精确匹配 → l0TextIndex → 空（首次）
  未命中，下探 L1

L1 向量搜索:
  EmbeddingProvider.embed(normalized) → 384维向量 (~2ms)
  遍历 embeddingMatrix → cosine similarity → 0 条历史，无结果
  未命中

快路径无匹配 → 不注入 → 错误写入待处理队列
```

---

## 第 6 步：异步阶段1 — L2 匹配 + 任务①分组

```
L2 LLM 语义匹配：
  输入: normalized + 上下文 + 历史 knowledge
  输出: { "matches": [] }   ← 全新类型

任务① 错误分组：
  输入: normalized + errorCode(TS2322) + command + 空分组列表
  AI 输出:
    {
      "isNewGroup": true,
      "groupId": "grp-zustand-null-access",
      "groupSummary": "Zustand store 返回可能为 null 的值被直接访问，未做空值保护",
      "errorTemplate": "TS2322 + TypeError: accessing property on possibly-null value from Zustand store selector",
      "isProjectSpecific": false
    }
```

---

## 第 7 步：Agent 修复错误

Claude Code 自行修复 `src/pages/Home.tsx`：

```diff
- console.log(user.name);
+ console.log(user?.name);
```

运行 `npm run dev` → 成功，无错误输出。

---

## 第 8 步：修复检测触发

PostToolUse 回调 → 工具输出正常 → 遍历待处理队列：
  - 队列中有 `normalized: "...Cannot read properties of null..."` 来自 `src/pages/Home.tsx`
  - 当前工具执行成功，同命令 `npm run dev` → 判断该错误已消失

→ 触发 extractFix：
```typescript
{
  error: <上述 ErrorEvent>,
  codeBefore: "console.log(user.name);",
  codeAfter:  "console.log(user?.name);",
  diff: "- console.log(user.name);\n+ console.log(user?.name);"
}
```

---

## 第 9 步：异步阶段2 — 任务②策略提取 + 入库

```
任务② 修复策略提取：
  输入: normalized + code_before + code_after + diff
  AI 输出:
    {
      "strategy": "对可能为 null 的 store 返回值使用可选链 ?. 做安全访问",
      "rootCause": "Zustand store 初始状态为 null，组件渲染时直接访问属性导致空指针",
      "applicableConditions": "TypeScript 项目中使用 Zustand/store 管理可空状态",
      "isProjectSpecific": false,
      "confidence": 0.9
    }
```

入库：
```
EmbeddingProvider.embed(normalized) → Float32Array
  → 写入 ErrorKnowledge.embedding
  → MemoryIndex.update()           // 内存热更新
  → SQLite.upsert()                // 磁盘持久化

新条目:
{
  groupId: "grp-zustand-null-access",
  summary: "Zustand store 返回可能为 null 的值被直接访问...",
  embedding: Float32Array([0.12, -0.34, ...]),  // 384维
  occurrences: 1,
  status: "active",
  solutions: [{
    strategy: "使用可选链 ?. 做安全访问",
    rootCause: "store 初始状态为 null",
    aiConfidence: 0.9,
    verifiedCount: 1
  }],
  tags: ["typescript", "zustand", "null-check"]
}
```

热更新完成。待处理队列中清除此条。

---

## 第 10 步：同一会话内，再次遇到同类错误

开发者继续让 Claude Code 加另一个 store：

```typescript
const settings = useSettingsStore((s) => s.theme);
document.body.className = settings.value; // 又没判空
```

终端报错：`Cannot read properties of undefined (reading 'value')`

---

## 第 11 步：快路径命中（L1）

```
预处理 → normalized: "Cannot read properties of undefined (reading '<ID>')"

L0: errorCode 匹配 → l0Index.get(undefined) → 空
    normalized 文本精确匹配 → 空（文本不同，null vs undefined）

L1: EmbeddingProvider.embed(normalized) → cosine similarity:
    grp-zustand-null-access → 0.91  ← 语义接近：都是 store 空值访问
    similarity > 0.7 ✓ → 命中！

< 5ms 完成匹配
```

---

## 第 12 步：适配器注入知识到 Agent

MatchEngine 返回最佳匹配 → Agent 适配器调用 `injectOnError()`，注入一条知识到 Claude Code 上下文：

```
[系统] 知识库匹配: grp-zustand-null-access (相似度 91%)
  策略: 使用可选链 ?. 做安全访问
  根因: store 初始状态为 null/undefined，组件渲染时直接访问属性
  置信度: 0.9 | 出现: 2 次
```

---

## 第 13 步：AI 参考历史，精准修复

Claude Code 看到注入的知识，直接定位：

```diff
- document.body.className = settings.value;
+ document.body.className = settings?.value;
```

---

## 第 14 步：后续会话，跨项目复用

一周后，开发者在**另一个项目**（Vue + Pinia）中也踩了类似的坑：

```
TypeError: Cannot read properties of null (reading 'title')
```

L1 向量搜索命中 `grp-zustand-null-access`（similarity 0.88）。

虽然技术栈不同（Zustand vs Pinia），L1 embedding 匹配到相同语义模式：**store 初始状态空值 + 直接属性访问**。注入知识后 AI 自动加判空。

---

## 流程总结

```
会话内:
  错误 → 预处理 → L0/L1 匹配(< 5ms)
    ├→ 命中 → 注入一条知识 → AI 参考修复
    └→ 未命中 → 待处理队列 → Agent 自行修复
      → 修复检测 → 异步阶段1(L2+分组) → 异步阶段2(策略+入库)
      → 热更新 → 同类错误再出现 → L0/L1命中

跨会话:
  启动 → 加载 SQLite → 构建内存索引 → 所有项目共享知识

团队 (后期):
  云端同步 → 团队知识池
```
