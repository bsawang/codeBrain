# Agent 适配器契约 — codebrain v0.15

## Agent 系统必须提供的 3 个能力

任何 AI 编码 Agent 要接入 codebrain，必须满足以下三项：

### 能力 1：工具执行回调

**Agent 系统必须在每次工具执行完成时通知 codebrain。**

| 要求 | 说明 |
|------|------|
| 时机 | 工具执行完成后立即触发（同步或异步回调） |
| 数据 | 执行的命令、stdout+stderr 输出、exit code、时间戳 |
| 方向 | Agent → codebrain |
| Claude Code 等价物 | `PostToolUse` hook |

```
tool_executed(command, output, exitCode, timestamp) → codebrain
```

### 能力 2：会话上下文访问

**codebrain 需要读取 Agent 会话历史，获取代码变更上下文。**

| 要求 | 说明 |
|------|------|
| 时机 | 修复检测触发时（按需读取） |
| 数据 | 最近的对话/工具调用历史、代码变更（diff 或 before/after） |
| 方向 | codebrain → Agent（读取） |
| Claude Code 等价物 | 会话文件或 API 读取 |

```
session.getRecentHistory(n) → messages + tool results
session.getFileChanges() → git diff 或文件内容变更
```

### 能力 3：上下文注入

**codebrain 需要将知识注入到 Agent 的当前会话中。**

| 要求 | 说明 |
|------|------|
| 时机 | 错误发生 + L0/L1 命中的同步快路径 |
| 数据 | 一条极简格式的知识（~40 tokens） |
| 方向 | codebrain → Agent（写入） |
| 形式 | 追加为不可见的系统消息，或追加到当前消息上下文 |
| Claude Code 等价物 | hook 返回值 / 消息流修改 |

```
injectSystemMessage(compactKnowledge) → Agent 下一条消息携带该上下文
```

---

## 不需要的能力

以下能力**不需要**，设计时已刻意避开：

| 不需要 | 原因 |
|--------|------|
| Agent 内部模型访问 | 不读写 Agent 的模型参数 |
| 预加载/会话启动注入 | 纯 hooks 实时注入，不做预加载 |
| 项目文件写入 | 不写 CLAUDE.md、不创建项目级文件 |
| 前台交互 | 不弹窗、不打断用户 |
| 会话修改/截断 | 不删除、不截断 Agent 消息 |
| 预置知识库 | 不从外部导入基因/胶囊，从零生长 |

---

## 接口契约

```typescript
interface AgentAdapterContract {
  // —— 能力 1：Agent 必须调用的通知 ——
  // 工具执行完成时，Agent 调用此方法
  onToolExecuted(params: {
    command: string;
    output: string;        // stdout + stderr 全文
    exitCode: number;
    timestamp: number;
    os?: string;
  }): Promise<void>;

  // —— 能力 2：codebrain 读取 Agent 上下文 ——
  // codebrain 按需调用，获取修复前后的代码
  getSessionContext(sessionId: string): Promise<{
    recentMessages: { role: string; content: string }[];
    recentToolResults: { command: string; output: string; exitCode: number }[];
  }>;

  // —— 能力 3：codebrain 注入知识到 Agent ——
  // codebrain 调用此方法向 Agent 注入一条知识
  injectKnowledge(knowledge: {
    fix: string;
    root: string;
    avoid: string;
    occurrences: number;
    verifiedCount: number;
    versionDiff?: string;
  }): Promise<void>;
}
```

## 适配器注册与卸载

codebrain 以 `codebrain` 为前缀命名所有 hook，便于识别和清理。

**注册**：`codebrain hook register <agent>`
**卸载**：`codebrain hook unregister <agent>`

### 各 Agent 操作细节

| Agent | 注册操作 | 卸载操作 |
|-------|---------|---------|
| Claude Code | 追加 hook 到 `~/.claude/settings.json` 的 `hooks` 数组 | 移除 `name` 以 `codebrain-` 前缀开头的条目 |
| Codex CLI | 写入 `~/.codex/hooks.json`，在 `~/.codex/config.toml` 设 `hooks = true` | 移除 `codebrain-` 前缀条目；若无其他 hook，`hooks = false` |
| Gemini CLI | 追加到 `~/.gemini/settings.json` 的 `hooks` 键下 | 移除 `codebrain-` 前缀条目 |
| Cursor CLI | 写入 `~/.cursor/hooks.json` | 移除 `codebrain-` 前缀条目 |

### 卸载原则

- 只移除 codebrain 写入的条目，不碰用户/其他工具配置
- 卸载后配置文件保留有效 JSON，不损坏 Agent 原有设置
- `codebrain uninstall` = 所有已注册 Agent 逐一卸载 + 可选 `~/.codebrain/` 清理

## 实现检查清单（以 Claude Code 为例）

| # | 需求 | Claude Code 实现 | 状态 |
|---|------|-----------------|------|
| 1 | 工具执行回调 | `PostToolUse` hook | 需验证数据字段完整性 |
| 2 | 会话上下文 | hook 可访问的 session / transcript | 需验证 diff 是否可获取 |
| 3 | 上下文注入 | hook 返回值 / 消息追加 | 需验证注入后 AI 是否可见 |
| 4 | 注册/卸载 | 写入 JSON 配置 + 前缀标记 | 需验证 Agent 热加载配置 |
