# CodeBrain

> 系统级 AI 编码 Agent 自进化错误记忆框架

[![npm](https://img.shields.io/npm/v/@bsawang/codebrain)](https://www.npmjs.com/package/@bsawang/codebrain)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

CodeBrain 是一个为 AI 编码 Agent（如 Claude Code）设计的**错误记忆与知识复用系统**。它拦截 Agent 的工具执行输出，自动提取、分组、归纳错误修复经验，并在同类错误再次出现时向 Agent 注入已验证的修复方案。

```
冷启动: 看到错误 → 分析 → 修复 → CodeBrain 自动提取策略
再次遇到: 看到错误 + CodeBrain 注入历史修复方案 → 直接修复
```

---

## 核心能力

| 能力 | 说明 |
|------|------|
| **L0 精确匹配** | 错误文本归一化后精确查询，<1ms |
| **L1 向量匹配** | 本地 embedding 语义相似度搜索，<5ms |
| **策略提取** | 从错误+修复差异中自动提取 fix/rootCause/avoid |
| **错误分组** | LLM 语义分组，不同措辞的同类错误归入同一组 |
| **规则归纳** | 同组累积验证 ≥3 次后，自动归纳通用预防规则 |
| **防循环** | 同组注入 ≥3 次自动抑制，第2次降级 warning |
| **全异步** | LLM 调用均为后台执行，不阻塞 Agent 主链路 |

---

## 架构

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  onError()  │ ──▶ │  MatchEngine │ ──▶ │ MemoryIndex │
│  (入口)     │     │  L0/L1 匹配  │     │  (内存索引) │
└──────┬──────┘     └──────────────┘     └─────────────┘
       │
       ▼
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│ AIAnalyzer  │ ◀── │CodeBrainEngine│ ──▶ │  StorageEngine  │
│ (LLM 归纳)  │     │  (调度中心)   │     │  (SQLite 持久化)│
└─────────────┘     └──────────────┘     └─────────────────┘
```

**数据流**: 错误 → Preprocessor 归一化 → L0/L1 匹配 → 命中则注入方案 / miss 则入队等待修复

**三层匹配**:
- **L0**: 归一化文本精确查询 + substring 兜底
- **L1**: Xenova/MiniLM-L6-v2 本地 embedding 余弦相似度 (384维, 阈值 0.7)
- **L2**: LLM 语义匹配 (按需启用，当前 L0/L1 召回率已够用)

详细时序参考 [docs/core-flow-timeline.md](docs/core-flow-timeline.md)

---

## 快速开始

### 安装

```bash
npm install -g @bsawang/codebrain
```

### 配置

创建 `~/.codebrain/config.yaml`:

```yaml
llm:
  provider: deepseek
  model: deepseek-chat
  apiKey: sk-your-api-key     # DeepSeek API key

embedding:
  provider: xenova
  model: MiniLM-L6-v2          # 本地运行，无需 API key
```

> 首次运行会自动下载 Xenova embedding 模型 (~80MB)，之后缓存到本地。

### 接入 Claude Code

```bash
# 一键安装
codebrain setup

# 或手动注册 hook
codebrain hook register claude-code
```

注册后 Claude Code 每次执行命令：
1. stdout/stderr 自动发送到 CodeBrain daemon
2. 命中历史错误时注入方案到 Agent 上下文
3. 修复成功时自动提取策略入库

查看状态：`codebrain stats`

### CLI 命令

```bash
codebrain                          # 帮助信息
codebrain setup                    # 一键安装 (配置 + daemon + hook)
codebrain daemon <start|stop|status>  # daemon 管理
codebrain stats                    # 知识库统计
codebrain list                     # 列出所有分组
codebrain tree                     # 按分类树状展示
codebrain show <groupId>           # 查看分组详情
codebrain search <keyword>         # 搜索知识库
codebrain prune                    # 清理已弃用条目
codebrain hook register claude-code  # 注册 Claude Code hook
```

---

## 编程接口

```ts
import { CodeBrainEngine, StorageEngine, XenovaEmbeddingProvider, DeepSeekProvider, createErrorEvent } from '@bsawang/codebrain';

const engine = new CodeBrainEngine(
  new XenovaEmbeddingProvider(),
  new DeepSeekProvider({ apiKey: '...', model: 'deepseek-chat' }),
  new StorageEngine(),
);
await engine.initialize();

// 错误发生时
const err = createErrorEvent('TypeError: ...', { command: 'npm test' });
const injection = await engine.onError(err);
// injection → null (miss) 或 "[codebrain]\nfix: ..." (命中)

// 修复后
engine.onFixDetected({ error: err, codeBefore, codeAfter, diff });
// → 异步提取策略入库

// 命令成功
await engine.onSuccess('npm test', 0);
// → verifiedCount++ / 触发规则归纳
```

导出清单见 [src/index.ts](src/index.ts)

---

## 配置项

| 键 | 默认值 | 说明 |
|----|--------|------|
| `llm.provider` | `deepseek` | LLM 提供商 (deepseek/openai) |
| `llm.model` | `deepseek-chat` | 模型名 |
| `llm.apiKey` | - | API key (不配则用 mock) |
| `llm.baseUrl` | - | 自定义 API 地址 |
| `embedding.provider` | `xenova` | embedding 提供商 |
| `embedding.model` | `MiniLM-L6-v2` | 本地模型名 |

---

## 存储

- **内存索引**: L0 文本/错误码 Map + L1 embedding 矩阵，查询 <5ms
- **SQLite 持久化**: `~/.codebrain/knowledge.db` (sql.js WASM 实现，跨平台)

---

## 依赖

| 包 | 用途 |
|----|------|
| `@xenova/transformers` | 本地 embedding 模型 (MiniLM-L6-v2) |
| `sql.js` | SQLite WASM 实现 |
| `yaml` | 配置文件解析 |
| `figlet` | CLI splash 页面 |

**Node.js ≥ 22**

---

## License

MIT © [bsawang](https://github.com/bsawang)
