# Agent 适配器可行性验证

## 总览

| Agent | C1 工具回调 | C2 会话访问 | C3 上下文注入 | 结论 |
|-------|-----------|-----------|-------------|------|
| **Claude Code** | ✅ PostToolUse | ✅ transcript_path | ✅ additionalContext | **完全支持** |
| **OpenAI Codex CLI** | ✅ PostToolUse | ✅ transcript_path | ✅ additionalContext | **完全支持** |
| **Gemini CLI** | ✅ AfterTool | ✅ transcript_path | ✅ additionalContext | **完全支持** |
| **Cursor CLI** | ✅ postToolUse | ✅ stream-json | ⚠️ 间歇性 bug | **基本支持** |
| Copilot SDK | ⚠️ 子 Agent 不触发 | ❌ 需自建日志 | ✅ additionalContext | 部分可行 |
| Amazon Q CLI | ✅ | ⚠️ 需自建 | ⚠️ 非专用字段 | 已停止维护 |
| Windsurf | ❌ 无逐工具 hook | ✅ | ❌ 无注入机制 | 不支持 |
| Kiro CLI | ❌ 文件事件驱动 | ❌ | ❌ 架构不匹配 | 不支持 |

---

## 完全支持的 Agent（三剑客）

### Claude Code（MVP）

**架构**：同步 Agent 循环 + stdin/stdout JSON hook 协议

| 能力 | 机制 | 细节 |
|------|------|------|
| C1 | `PostToolUse` hook | `tool_name`, `command`, `stdout`, `stderr` |
| C2 | `transcript_path` | JSONL 文件，hook 内直接读取 |
| C3 | `additionalContext` | stdout JSON 返回，注入 `<system-reminder>` |

微小缺口：无显式 `exit_code`（通过 `interrupted` 判断），无 `timestamp`（适配器自生成）。均可绕过。

### OpenAI Codex CLI

**架构**：与 Claude Code 近乎相同（Rust 实现，同架构，hook API 有意对标）

| 能力 | 机制 | 细节 |
|------|------|------|
| C1 | `PostToolUse` hook | 含 `exit_code`，比 Claude Code 更完整 |
| C2 | `transcript_path` | 同 Claude Code |
| C3 | `additionalContext` | 比 Claude Code 更早实现 PostToolUse 上的注入 |

开源（Apache 2.0），Rust 代码可参考。适配器工作量接近 Claude Code。

### Gemini CLI

**架构**：Node.js，有意兼容 Claude Code hook 协议

| 能力 | 机制 | 细节 |
|------|------|------|
| C1 | `AfterTool` hook | `tool_name`, `tool_input`, `tool_response` |
| C2 | `transcript_path` | 同 Claude Code |
| C3 | `additionalContext` | 在 `AfterTool` 上："Text appended to the tool result for the agent" |

也开源（Apache 2.0）。Google 正在将其终端体验迁移到 Antigravity CLI（Go），但 hook 系统保留。

---

## 部分支持 / 架构不兼容的

| Agent | 核心问题 |
|-------|---------|
| Copilot SDK | 子 Agent tool 调用不触发 hook，需等修复；无 transcript，需自建日志 |
| Cursor CLI | C3 有已确认 bug（context 被记录但未送达模型），应会修复 |
| Amazon Q CLI | 已停止维护，AWS 转向 Kiro CLI |
| Windsurf | hook 粒度是"响应级"而非"工具级"，无 PostToolUse 等价物 |
| Kiro CLI | 事件驱动而非 Agent 循环，架构根本不同 |

---

## 适配优先级

```
一期 (MVP)：     Claude Code          ← 已验证，Evolver 已实现
二期 (扩展)：     OpenAI Codex CLI     ← 架构最接近，适配成本最低
                Gemini CLI           ← 有意兼容，适配成本低
三期 (跟踪)：     Cursor CLI           ← 等 C3 bug 修复
                Copilot SDK          ← 等子 agent hook 修复
不考虑：          Windsurf / Kiro / Amazon Q
```

## 适配器可以共享的代码比例

三个完全支持的 Agent 共享同一套 hook 协议模式（stdin JSON in / stdout JSON out / transcript_path / additionalContext），差异仅在于字段名和细微语义。核心引擎和匹配层完全复用，适配器只是薄薄的翻译层，预估：

```
代码量比: 核心引擎 80% / Claude Code 适配器 8% / Codex 适配器 5% / Gemini 适配器 5% / 公共适配基类 2%
```
