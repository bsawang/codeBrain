# 开发错误自进化记忆框架 — 需求文档 v0.15

## 一、项目定位

一个**系统级的、面向 AI 编码 Agent 的自进化错误记忆框架**。

> 像 `git` 一样全局安装，在任何项目目录下自动工作。从 AI Agent 会话中提取错误 → AI 分析层理解语义、归纳模式 → 沉淀为结构化知识 → 注入回 Agent 后续会话，让 AI **自主避坑、自主优化、无需用户参与**。

**三个核心设计决策**：
1. **系统级** — 全局安装，跨项目生效，和 `git`、`node` 同级
2. **Agent 就是采集器** — 不需要独立的采集适配器层，所有错误已在 Agent 会话上下文中
3. **AI 分析语义，不是规则匹配** — 错误分组、策略提取、相似匹配全由 LLM 驱动

---

## 二、部署模型

```
全局安装: npm install -g codebrain

~/.codebrain/
├── config.yaml          # 配置
├── knowledge.db         # SQLite 知识库（所有项目共享）
└── logs/                # 运行日志
```

- **纯系统级**：所有知识存在 `~/.codebrain/knowledge.db`，不分项目目录
- **零项目侵入**：不在项目下创建任何文件，不进 git
- **团队共享（后期）**：云端同步层对接，多地实例作为一个节点

---

## 三、架构

```
                         任何项目的 AI Agent 会话
                                  │
                                  ▼
                ┌─────────────────────────────────┐
                │         codebrain                 │
                │         (全局安装，按需启动)       │
                │                                  │
                │  ┌───────────────────────────┐   │
                │  │      Agent 适配器          │   │
                │  │  ① 提取错误  ② 注入知识    │   │
                │  └─────────────┬─────────────┘   │
                │                │                  │
                │  ┌─────────────┴─────────────┐   │
                │  │        核心引擎             │   │
                │  │  ┌─────────────────────┐  │   │
                │  │  │  算法预处理（规则）    │  │   │
                │  │  ├─────────────────────┤  │   │
                │  │  │  AI 分析层（LLM驱动） │  │   │
                │  │  ├─────────────────────┤  │   │
                │  │  │  算法后处理（规则）    │  │   │
                │  │  └─────────────────────┘  │   │
                │  └─────────────┬─────────────┘   │
                │                │                  │
                │  ┌─────────────┴─────────────┐   │
                │  │   存储引擎 (内存+SQLite)    │   │
                │  │   ~/.codebrain/knowledge.db│   │
                │  └───────────────────────────┘   │
                └─────────────────────────────────┘
```

- **Agent 适配器** — 对接不同 Agent 的生命周期（提取错误 + 注入知识）
- **核心引擎** — 算法预处理 + AI 分析 + 算法后处理
- **存储引擎** — 内存索引 + SQLite 持久化

---

## 四、配置

Agent 类型由调用方（hook）运行时决定，不在配置中声明。配置只管用户级偏好。

```yaml
# ~/.codebrain/config.yaml
llm:
  provider: deepseek
  model: deepseek-chat
embedding:
  provider: xenova
  model: MiniLM-L6-v2
```

---

## 五、Agent 适配器

```typescript
interface AgentAdapter {
  name: string;

  // 从 Agent 会话获取错误
  extractErrors(session: AgentSession): ErrorEvent[];

  // 获取修复后的代码变更
  extractFix(session: AgentSession, error: ErrorEvent): FixInfo | null;

  // 错误发生时实时注入（L0/L1 命中后）
  injectOnError(error: ErrorEvent, matched: ErrorKnowledge): void;
}

// 注入格式（极简）
const INJECTION_TEMPLATE = `
[codebrain]
fix: {{strategy}}
root: {{rootCause}}
avoid: {{avoidanceHint}}
hit: {{occurrences}}次 | v: {{verifiedCount}}
{{#versionDiff}}ver: 验证于 {{verifiedVersions}}（当前 {{currentVersions}} 未验证）{{/versionDiff}}
`;
```

| 适配器 | 提取方式 | 注入方式 |
|--------|---------|---------|
| `claude-code` | hooks (PostToolUse) 捕获终端错误 | hooks 实时注入到会话上下文 |
| `copilot` | 会话上下文解析 | System message / instructions 追加 |
| `cursor` | 会话上下文解析 | System message / rules 追加 |
| `openai-plain` | tool use 结果解析 | System message 追加 |
| `stdin` | stdin 接收 JSON | stdout 输出 |

---

## 六、核心引擎

### 6.1 整体流程

```
                    Agent 工具执行 (PostToolUse)
                           │
               ┌───────────┴───────────┐
               ▼                       ▼
         工具输出含错误              工具输出正常（之前有同类错误）
               │                          │
               ▼                          ▼
       ┌─────────────┐           ┌─────────────┐
       │  快路径:     │           │  修复检测:   │
       │  预处理      │           │  比对此前错误 │
       │  L0 → L1    │           │  是否消失    │
       │             │           │  提取 diff   │
       │  命中→注入   │           └──────┬──────┘
       │  未命中→下步 │                  │
       └──────┬──────┘                  │
              │                         │
              │           ┌─────────────┘
              ▼           ▼
       ┌─────────────────────────┐
       │      异步深路径          │
       │                         │
       │  阶段1（错误发生时）:     │
       │    任务① 错误分组        │
       │    L2 LLM 语义匹配      │
       │                         │
       │  阶段2（修复完成后）:     │
       │    任务② 策略提取        │
       │    → 入库                │
       │                         │
       │  阶段3（积累后）:         │
       │    任务③ 规则归纳        │
       └─────────────────────────┘
```

**如果 Agent 未能修复该错误（修复检测未触发），该错误事件丢弃，不沉淀。**

### 6.2 触发机制与类型定义

Agent 适配器每次收到工具执行回调时，根据输出内容分类：

| 输出特征 | 触发动作 |
|----------|---------|
| 含错误码/堆栈/异常关键词 | → 快路径（预处理 + L0/L1） |
| 执行成功 + 上一次同类错误消失 | → 修复检测（提取 diff）→ 深路径阶段2 |
| 执行成功 + 无关联错误 | → 忽略 |
| 含错误但 Agent 未修复 | → 丢弃 |

**待处理队列**：所有遇到的错误（无论 L0/L1 是否命中）写入内存轻量队列。每次工具执行成功（exit code 0）时遍历队列，检测同一命令之前的错误是否消失：
- 如果之前该错误 L0/L1 命中 → 意味着 AI 参考历史方案修了 → verifiedCount +1
- 如果之前该错误 L0/L1 未命中 → 触发修复检测 → 提取 diff → 异步阶段2
- 窗口外未消失的错误自动丢弃

```typescript
interface PendingError {
  normalized: string;
  sourceFile?: string;
  errorCode?: string;
  timestamp: number;
}
```

**类型定义**：

```typescript
interface AgentSession {
  sessionId: string;
  messages: { role: string; content: string; timestamp: number }[];
  toolExecutions: {
    command: string;
    output: string;           // 终端输出（stdout + stderr）
    exitCode: number;
    timestamp: number;
    os?: string;
  }[];
}

interface FixInfo {
  error: ErrorEvent;
  codeBefore?: string;         // 修复前代码
  codeAfter?: string;          // 修复后代码
  diff?: string;               // git diff
  fixTimestamp: number;
}
```

### 6.3 算法预处理

```typescript
interface ErrorEvent {
  raw: string;
  normalized: string;                       // 去ANSI、去路径、去行号、去时间戳
  errorCode?: string;
  command?: string;
  os?: string;
  sourceFile?: string;
  codeSnippet?: string;
  dependencies?: Record<string, string>;
  timestamp: number;
  sessionId?: string;
}
```

### 6.4 AI 分析层

模型无关，通过 prompt 模板 + `LLMProvider` 接口调用。

#### 系统角色设定（全局 prompt 前缀）

```
你是一个开发错误分析专家。你的任务是分析代码编译/运行时错误，
进行语义分组、提取修复策略、归纳抽象规则。

重要原则：
- 关注语义而非文本：根因相同即使措辞不同，归入同一组
- 关注项目特异性：识别与当前项目架构、依赖版本、配置相关的因素
- 输出结构化 JSON，不要输出额外解释
```

#### 四个任务 prompt 模板

```
任务① 错误分组：
  输入：{{normalized_error}} + {{error_code}} + {{command}} + {{existing_groups}}
  输出 JSON:
    {
      "isNewGroup": true/false,
      "groupId": "...",
      "groupSummary": "这类错误的本质（一句话）",
      "errorTemplate": "剥离项目变量后的通用错误模板",
      "isProjectSpecific": true/false
    }

任务② 修复策略提取（错误修复后触发）：
  输入：{{normalized_error}} + {{code_before}} + {{code_after}} + {{diff}}
  输出 JSON:
    {
      "strategy": "修复策略（做了什么）",
      "rootCause": "根因",
      "avoidanceHint": "一句话：什么情况/什么写法会触发这个错误，应避免什么"
    }

任务③ 规则归纳（同组 ≥3 条修复记录时触发）：
  输入：{{group_summary}} + {{group_events_with_solutions}}
  输出 JSON:
    {
      "abstractRule": "归纳出的一般性规则",
      "triggerDescription": "什么情况下触发这类错误",
      "preventionAdvice": "如何预防"
    }

任务④ 相似匹配（L2 层级，仅 L0/L1 不够时触发）：
  输入：{{normalized_error}} + 上下文(file/command/os) + {{knowledge_top_k}}
  输出 JSON:
    {
      "matches": [{ "groupId": "...", "relevance": 0.95, "reason": "..." }]
    }
```

#### 分层匹配引擎（快路径核心）

核心原则：**毫秒级响应不能依赖网络调用**。快路径走本地计算，LLM 只作为后备。

```
错误来
    │
    ▼
┌──────────────────────────────────────────────────┐
│  L0 精确匹配 (< 1ms)                              │
│                                                   │
│  · 错误码 (TS2322) → 哈希表 O(1) 查已有分组        │
│  · normalized 文本 → 精确字符串匹配                 │
│  · 命中 → 直接返回匹配结果，跳过后续                │
│  · 匹配精度 = 精确（文本完全相同）                   │
└──────────────────────┬────────────────────────────┘
                       │ 未命中
                       ▼
┌──────────────────────────────────────────────────┐
│  L1 向量相似搜索 (~1-5ms)                           │
│                                                   │
│  · 历史知识入库时已预计算 embedding 存储            │
│  · 当前错误的 normalized text → 本地模型即时推理    │
│  · 本地 embedding 模型（如 MiniLM-L6-v2, 384维）   │
│  · cosine similarity 遍历所有历史条目              │
│  · 返回 Top-K (K=5) 且 similarity > 阈值的结果     │
│  · 全程本地计算，不走网络，不进 GPU 也可            │
└──────────────────────┬────────────────────────────┘
                       │ 结果为空 或 最高相似度 < 阈值
                       ▼
┌──────────────────────────────────────────────────┐
│  L2 LLM 语义匹配 (~200-2000ms)                     │
│                                                   │
│  · L0/L1 都打不中，但有大量历史知识时触发           │
│  · 走异步，不阻塞 Agent                            │
│  · 结果异步注入（如果有价值）                       │
│  · 同时标记"待入库新分组"                           │
└──────────────────────────────────────────────────┘
```

**关键**：L0 和 L1 完全本地，不进网络。L0 命中 → < 1ms；L1 命中 → ~1-4ms。只有全新类型的错误才掉到 L2。

#### 热更新 + 分层匹配 结合

```
Agent 工具执行报错
    │
    ▼
┌──────────────────────────────┐
│  同步快路径 (< 5ms)           │
│  预处理 → L0 → L1             │
│    命中 → 立即注入一条知识     │
│    未命中 → 不注入             │
└─────────────┬────────────────┘
              │
              ▼
┌──────────────────────────────┐
│  异步：阶段1（错误发生时）     │
│  L2 语义匹配 + 任务①分组      │
│  → 确定 groupId               │
└─────────────┬────────────────┘
              │ Agent 修复完成后
              ▼
┌──────────────────────────────┐
│  异步：阶段2（修复完成后）     │
│  任务②策略提取 → 计算 embedding│
│  → 入库（内存 + SQLite）      │
│  → 入库后 L0/L1 即刻可命中     │
└──────────────────────────────┘
```

#### Embedding 生成与存储

```typescript
interface EmbeddingProvider {
  // 将文本转为向量，可用本地模型或轻量 API
  embed(text: string): Promise<number[]>;  // 如 384-dim / 768-dim
}
```

入库时由异步深路径自动调用：

```
第一个错误事件的 normalized 文本
    → EmbeddingProvider.embed(normalized)
    → 向量存入 ErrorKnowledge.embedding
    → 后续新错误的 normalized 文本同样做 embedding
    → 两个 embedding 做 cosine similarity
    → 同类型的错误，预处理后文本自然接近，L1 即可命中
```

**注意**：embedding 基于 `normalized`（规则预处理后的错误文本），不是 AI 生成的摘要。这样查询输入和存储输入是同源同质的，避免语义漂移。

#### 匹配引擎接口

```typescript
interface LLMProvider {
  complete(prompt: string, options?: { temperature?: number; maxTokens?: number }): Promise<string>;
}

// —— 匹配引擎相关类型 ——

interface MatchResult {
  groupId: string;
  relevance: number;           // 0-1
  reason: string;
  matched: ErrorKnowledge;
}

// —— AI 分析层类型 ——

interface GroupSummary {
  groupId: string;
  summary: string;
  errorTemplate: string;
  occurrences: number;
}

interface GroupingResult {
  isNewGroup: boolean;
  groupId: string;
  groupSummary: string;
  errorTemplate: string;
  isProjectSpecific: boolean;
}

interface SolutionExtraction {
  strategy: string;
  rootCause: string;
  avoidanceHint: string;
}

interface RuleInduction {
  abstractRule: string;
  triggerDescription: string;
  preventionAdvice: string;
}

interface StorageStats {
  totalGroups: number;
  totalEvents: number;
  lastUpdate: number;
}

class MatchEngine {
  constructor(embedding: EmbeddingProvider, llm?: LLMProvider) {}

  // —— L0 精确匹配 (< 1ms) ——
  matchExact(event: ErrorEvent, knowledge: ErrorKnowledge[]): MatchResult | null;

  // —— L1 向量搜索 (~1-4ms) ——
  matchVector(event: ErrorEvent, knowledge: ErrorKnowledge[], topK: number, threshold: number): MatchResult[];

  // —— 同步快路径：L0 + L1 ——
  async matchSync(event: ErrorEvent, knowledge: ErrorKnowledge[]): Promise<MatchResult | null> {
    const l0 = this.matchExact(event, knowledge);
    if (l0) return l0;
    
    const l1 = await this.matchVector(event, knowledge, 1, 0.7);
    return l1.length > 0 ? l1[0] : null;
  }

  // —— L2 LLM 语义匹配（异步，~200-2000ms） ——
  async matchLLM(event: ErrorEvent, knowledge: ErrorKnowledge[]): Promise<MatchResult[]> { ... }
}

class AIAnalyzer {
  constructor(llm: LLMProvider) {}
  
  // 异步深路径
  async groupError(event: ErrorEvent, existingGroups: GroupSummary[]): Promise<GroupingResult> { ... }
  async extractSolution(event: ErrorEvent, fix: FixInfo): Promise<SolutionExtraction> { ... }
  async induceRule(groupId: string, events: ErrorEvent[]): Promise<RuleInduction> { ... }
}
```

### 6.5 知识模型

```typescript
interface ErrorKnowledge {
  groupId: string;
  summary: string;
  errorTemplate: string;
  embedding?: Float32Array;                  // 预计算向量，L1 匹配直接入内存索引
  occurrences: number;
  firstSeen: number;
  lastSeen: number;

  solutions: Solution[];                    // 按 verifiedCount 降序排序
  abstractRule?: string;
  preventionAdvice?: string;
  triggerDescription?: string;

  status: 'active' | 'deprecated';           // 防循环抑制设置，可被 prune 清理
  dependencyVersions?: Record<string, string>;// 最近一次验证时的关键依赖版本
  isProjectSpecific: boolean;               // 分类标签，非路由字段
  tags: string[];
  relatedGroupIds: string[];
}

interface Solution {
  id: string;
  strategy: string;
  rootCause: string;
  avoidanceHint: string;                    // 一句话：不要做什么
  diff?: string;
  verifiedCount: number;                    // 执行 trace 验证成功次数（排序依据）
  suppressed: boolean;                      // 防循环抑制标记
  executionTrace?: {                        // 最近一次验证证据
    exitCode: number;
    command: string;
    timestamp: number;
    dependencyVersions?: Record<string, string>; // 验证时的版本
  };
  applicableConditions?: string;
}
```

### 6.6 算法后处理

- **去重合并**：同 groupId 事件合并，更新 occurrence 计数
- **策略去重**：入库前检查同 groupId 下是否已有语义相同的策略 → 合并版本范围、verifiedCount +1，不新建 Solution；仅策略/根因不同时才新增
- **verifiedCount 更新**：同 groupId 错误再次出现 + 修复检测成功（exit code 0）→ +1
- **排序依据**：匹配结果按 `verifiedCount` 降序，证据次数多的方案优先
- **版本追踪**：入库时记录当前项目关键依赖版本；匹配命中但版本不一致时，注入末尾追加版本提醒；不主动作废——旧方案在新版本下失效 → 防循环自动抑制 → 自然淘汰；旧方案在新版本下有效 → 新 executionTrace 更新版本信息
- **淘汰策略**：不设时间限制——方案是否有效由 execution trace 和防循环机制判断。手动 `prune` 清理 suppressed 条目

### 6.7 防循环机制

同一会话内，同 groupId 被反复命中意味着"这个方案可能不适用于当前场景"：

```
同 groupId 在 50 轮对话窗口内连续命中:

  1 次 → 正常注入
  2 次 → 降级注入（追加警告 "⚠ 此方案上次未解决该问题"）
  ≥3 次 → 停止注入，标记 suppressed = true

重置条件（任一满足）:
  · 成员手动编辑该方案并保存
  · 后续修复会话中该方案被采纳且修复成功（execution trace 产生）
  · 窗口滑动（50 轮后自动出窗）

L0 多值处理：同一错误码对应多个 groupId 时，优先注入未受抑制的、verifiedCount 最高的 Top 3

---

## 七、存储引擎

### 核心原则：内存热查询 + 磁盘冷持久

```
查询路径（L0/L1 匹配用）：
  不碰磁盘 → 直接读内存中的 Map 和 Float32 数组 → < 5ms

写入路径（深路径完成后）：
  写入内存（立即生效，热更新）+ 异步写入磁盘（持久化）

启动路径：
  从磁盘加载全量数据 → 构建内存索引 → 开始服务
```

### 内存索引结构

```typescript
class MemoryIndex {
  // L0: 错误码 → 分组列表（哈希表 O(1)）
  private l0Index: Map<string, string[]>;             // TS2322 → ["grp-1", "grp-5"]

  // L0: normalized 文本 → 分组列表（一个模板可匹配多个 groupId）
  private l0TextIndex: Map<string, string[]>;          // "Cannot read properties..." → ["grp-1", "grp-3"]

  // L1: 分组 ID → 预计算 embedding（Float32 数组，连续内存，利于 SIMD）
  private embeddings: Map<string, Float32Array>;       // "grp-1" → [0.12, -0.34, ...]

  // L1: 所有 embedding 矩阵（用于批量 cosine similarity）
  private embeddingMatrix: Float32Array[];              // [384-dim, 384-dim, ...]
  private groupIdsByRow: string[];                      // 矩阵行号 → groupId

  // 完整知识对象映射（匹配到 groupId 后取值）
  private knowledgeMap: Map<string, ErrorKnowledge>;
}
```

### 查询性能

```
L0 精确匹配:
  errorCode 命中 → l0Index.get("TS2322") → knowledgeMap.get(groupId)
  耗时: < 0.01ms (纯哈希)

  normalized 文本命中 → l0TextIndex.get(text)
  耗时: < 0.01ms

L1 向量搜索:
  1. 当前错误 → embedding 推理 (本地模型, ~1-3ms)
  2. embedding × embeddingMatrix → cosine similarity 向量 (~0.5ms for 500条×384维)
  3. 取 Top-K > 阈值
  总耗时: ~1-4ms
```

### 磁盘持久化

```typescript
interface DiskStore {
  // 全量加载（启动时用）
  loadAll(): Promise<ErrorKnowledge[]>;

  // 增量写入（深路径完成后）
  upsert(knowledge: ErrorKnowledge): Promise<void>;

  // 事件日志（审计用）
  logEvent(event: ErrorEvent): Promise<void>;
}
```

**MVP 使用 SQLite**：embedding 存 BLOB、groupId 建索引、WAL 模式并发读写。

### 存储路径

```
~/.codebrain/
├── config.yaml
├── knowledge.db       # SQLite，全量知识
└── logs/
```

### 启动流程

```
codebrain 启动
  → SQLite 加载 knowledge.db 全部 ErrorKnowledge
  → 遍历构建 MemoryIndex（L0 Map + L1 embedding 矩阵 + HNSW 图）
  → 内存索引就绪
```

### 写入 + 热更新流程

```
深路径完成 → AIAnalysisResult
  → 构建 ErrorKnowledge（含 embedding）
  → MemoryIndex.update(knowledge)       // 内存即时更新
  → SQLite.upsert(knowledge)            // 磁盘异步写入
  → 热更新完成
```

### 存储引擎接口

```typescript
interface StorageEngine {
  initialize(): Promise<void>;
  getIndex(): MemoryIndex;
  upsert(knowledge: ErrorKnowledge): Promise<void>;
  logEvent(event: ErrorEvent): Promise<void>;
  stats(): Promise<StorageStats>;
}
```

---

## 八、工作流闭环

```
Agent 工具执行 (PostToolUse)
        │
        ├── 输出含错误
        │     ├→ 预处理 + L0/L1 匹配
        │     │    ├→ 命中 → 注入一条知识 → Agent 参考修复
        │     │    └→ 未命中 → 标记为待处理 → Agent 自行修复
        │     └→ 异步阶段1: L2 匹配 + 任务①分组
        │
        ├── Agent 修复（工具输出正常，且待处理队列中有同类错误）
        │     └→ 提取 diff → 异步阶段2: 任务②策略提取 → 入库（热更新）
        │
        └── Agent 未修复（输出仍有错，或错误被丢弃）
              └→ 不做任何处理

下次会话 → 加载 SQLite → 构建内存索引 → 继续积累
后期: 云端同步实现团队共享
```

---

## 九、知识库管理 UI

虽然是 AI 自动驱动的框架，但人需要能查看和整理积累的知识。

### CLI 命令

```bash
# 查看摘要
codebrain stats              # 知识库统计：总分、本月新增、Top 错误类型
codebrain list               # 列出所有错误分组，按热度排序
codebrain list --tag=zustand # 按标签筛选

# 查看详情
codebrain show <groupId>     # 查看一个分组的完整信息：摘要、根因、修复策略、事件历史

# 搜索
codebrain search "<keyword>" # 模糊搜索分组摘要和错误模板

# 维护
codebrain prune              # 清理长期 suppressed 且未被手动恢复的条目
codebrain forget <groupId>   # 手动删除一条知识
codebrain edit <groupId>     # 打开编辑器修改摘要/策略
```

### 本地 Web 面板

```
codebrain ui
  → 启动 localhost:PORT
  → 浏览器打开管理面板
```

面板功能：

- **总览**：总分组数、本月新增、top 高频错误柱状图
- **错误列表**：分组表格，按热度/时间/验证次数排序，支持标签筛选
- **详情页**：单分组完整信息——摘要、错误模板、根因、所有修复方案、事件时间线
- **手动编辑**：修正 AI 的摘要/策略，手动关联分组，解除抑制
- **清理**：勾选 deprecated 条目，批量删除

---

## 十、MVP 范围

**目标**：系统级工具，验证完整闭环。

**包含**：
1. 全局 CLI：`npm install -g codebrain`
   - 子命令：`stats`、`list`、`show`、`search`、`prune`
2. 核心引擎
   - 算法预处理
   - L0 + L1 本地匹配（< 5ms）
   - L2 LLM 语义匹配（异步）
   - AI 分析层深路径（任务①②）
   - 算法后处理 + 防循环机制
   - EmbeddingProvider（本地轻量模型）
3. Claude Code 适配器
4. SQLite 存储 + 内存索引（WAL 模式）
5. 全局配置

**不包含**：
- 任务③规则归纳
- Web UI 面板（先做 CLI，二期）
- Copilot / Cursor 适配器
- 云端同步

---

## 十一、已确定的设计决策

1. **系统进程形态** → 按需启动（hook 触发）
2. **Embedding 模型** → Xenova transformers + MiniLM-L6-v2（384维）
3. **HNSW 切换阈值** → 5000 条
4. **npm 包结构** → 先单包，保留多包扩展接口
5. **注入策略** → 纯 hooks 实时注入，仅错误发生时精准注入一条，极简格式（~40 tokens）
6. **存储** → SQLite + 内存索引，单层 `~/.codebrain/knowledge.db`
7. **配置** → 简洁全局配置（仅 LLM + embedding），Agent 类型由调用方决定
8. **防循环** → 同 groupId 连续命中 ≥2 次降级，≥3 次抑制
9. **知识验证** → 所有修复方案必须携带 execution trace（exit code 0）
10. **排序** → 按 verifiedCount 降序，证据驱动，不用置信度

---

> v0.15 — 砍掉时间淘汰，方案有效性仅由 execution trace + 防循环判断，纯证据驱动。
