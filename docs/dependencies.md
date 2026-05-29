# 外部依赖清单 — codebrain v0.15

## 一、运行时依赖（必需的）

| 依赖 | 用途 | 类型 |
|------|------|------|
| Node.js ≥ 22 | 运行时 | **必须** |
| npm | 全局安装/分发 | **必须** |
| 文件系统 | `~/.codebrain/` 读写 | **必须** |

## 二、可配置依赖

### 2.1 LLM 层

| 接口 | 用途 | 可切换？ | 备注 |
|------|------|---------|------|
| `LLMProvider` | 异步深路径：任务①分组、任务②策略提取、任务③规则归纳、L2 语义匹配 | **可配置** | deepseek / openai / anthropic / 本地模型 |
| `EmbeddingProvider` | L1 向量搜索：文本 → 向量 | **可配置** | Xenova MiniLM-L6-v2（默认）/ OpenAI text-embedding / 其他 |

### 2.2 存储层

| 接口 | 用途 | 可切换？ | 备注 |
|------|------|---------|------|
| `DiskStore` | SQLite 持久化 | 固定 | MVP 用 SQLite，后期可加 remote-api |

## 三、需要适配的外部系统

### 3.1 Agent 适配器

| 系统 | 接入点 | 提取方式 | 注入方式 | 适配难度 |
|------|--------|---------|---------|---------|
| **Claude Code** | hooks (PostToolUse/SessionStart) | 解析工具执行输出 | 追加到消息流 | MVP |
| Copilot | VS Code Extension API | 解析 agent 会话 | instructions 文件 / stream | 中 |
| Cursor | Cursor 内部 API | 解析会话 | .cursorrules | 中 |
| OpenAI Agent SDK | tool result 回调 | 解析 tool result | system message 追加 | 低 |
| 通用 CLI (stdin) | 管道输入 | JSON stdin | stdout | 低 |

### 3.2 IDE 集成

| 系统 | 依赖方式 | 备注 |
|------|---------|------|
| VSCode | Claude Code 插件下的 hook | 通过 Claude Code 间接接入，不直接依赖 VSCode API |
| JetBrains | 后期 | 需要独立适配器 |

## 四、依赖层级图

```
codebrain
  ├── Node.js (必须)
  ├── npm (分发)
  │
  ├── [可配置]
  │   ├── LLMProvider → deepseek / openai / anthropic / ollama
  │   └── EmbeddingProvider → xenova / openai-embedding
  │
  ├── [适配层]
  │   └── AgentAdapter
  │       ├── Claude Code (MVP)
  │       ├── Copilot (后期)
  │       ├── Cursor (后期)
  │       ├── OpenAI (后期)
  │       └── stdin (后期)
  │
  └── [存储]
      └── SQLite (better-sqlite3)
```

## 五、npm 依赖与容量

| 包 | 用途 | 大小 | |
|----|------|------|------|
| `@xenova/transformers` | L1 embedding 推理 (ONNX Runtime) | ~15MB | **必须** |
| `better-sqlite3` | SQLite 原生绑定 | ~3MB(编译后) | **必须** |
| `yaml` | 配置解析 | ~0.1MB | **必须** |
| `hnswlib-node` | HNSW 向量索引 (>5000条) | ~2MB | 后期可选 |
| codebrain 本体 | 核心引擎 + 适配器 | ~0.5MB | **必须** |

**首次安装**：
```
npm install -g codebrain  →  ~20MB（npm 包 + 依赖库）
```

**首次运行**（模型自动下载）：
```
MiniLM-L6-v2 ONNX 模型  →  ~80MB（缓存到 ~/.cache/transformers/）
```

**总磁盘占用**：~100MB（20MB 库 + 80MB 模型）

**后续运行**：模型已缓存，启动即用，不再下载。

## 六、关键约束

- **除 better-sqlite3 外零原生编译**：Xenova 通过 ONNX Runtime WebAssembly 运行，不需要系统级的 Python/C++ 工具链
- **零外部服务依赖**：LLM 调用走网络（用户已有的 API），其余全本地
- **零项目文件写入**：只写 `~/.codebrain/`，不碰项目目录
