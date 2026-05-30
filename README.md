# CodeBrain

> 系统级 AI 编码 Agent 自进化错误记忆框架

[![npm](https://img.shields.io/npm/v/@bsawang/codebrain)](https://www.npmjs.com/package/@bsawang/codebrain)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

像 `git` 一样全局安装，在任何项目目录下自动工作。从 AI Agent 会话中提取错误 → AI 分析层理解语义、归纳模式 → 沉淀为结构化知识 → 注入回 Agent 后续会话，让 AI **自主避坑、自主优化、无需用户参与**。

---

## 亮点

### 系统级，零侵入

全局安装，跨项目生效。所有知识存在 `~/.codebrain/knowledge.db`，不在项目下创建任何文件，不进 git。和 `git`、`node` 同级——装上就忘掉。

### 快响应，毫秒级

错误发生后毫秒级匹配历史知识，匹配到就立即注入修复方案，不阻塞 Agent 工作流。整个过程走本地计算、不进网络，只有全新类型的错误才会异步调用 LLM 分析。

### AI 语义匹配，更准确

错误分组、策略提取、规则归纳全由 LLM 驱动。关注语义而非文本——根因相同即使措辞不同（`null` vs `undefined`，`name` vs `value`），归一化后自动归入同一组。不是写死一堆正则，而是让 AI 理解错误本质。

### 跨项目复用，自进化

所有项目共享同一知识库。在项目 A 修过的错误，到项目 B 直接命中注入。修得越多，命中越快。积累的知识随使用自动增长。

---

## 快速开始

### 安装

```bash
npm install -g @bsawang/codebrain
```

### 配置

```bash
codebrain setup
```

交互式引导完成：LLM API key 配置、本地 embedding 模型下载（~80MB）、
Daemon 启动 + Claude Code hook 注册。

也可以手动编辑 `~/.codebrain/config.yaml` 调整参数：

| 键 | 默认值 | 说明 |
|----|--------|------|
| `llm.provider` | `deepseek` | LLM 提供商 |
| `llm.model` | `deepseek-chat` | 模型名 |
| `llm.apiKey` | - | API key |
| `llm.baseUrl` | - | 自定义 API 地址 |
| `embedding.provider` | `xenova` | 本地 embedding |
| `embedding.model` | `MiniLM-L6-v2` | 384维本地模型 |

### 接入 Claude Code

```bash
codebrain hook register claude-code   # 注册
codebrain hook unregister claude-code # 卸载
```

注册后 Claude Code 的工具执行输出会自动发送到 CodeBrain daemon，错误命中即注入修复方案，修复成功即提取策略入库。

### CLI 命令

```bash
codebrain                 # 帮助
codebrain setup           # 一键安装
codebrain stats           # 知识库统计
codebrain list            # 分组列表（按热度排序）
codebrain tree            # 按分类树状展示
codebrain show <groupId>  # 分组详情
codebrain search <kw>     # 搜索
codebrain prune           # 清理已弃用条目
```

### Web UI

```bash
codebrain daemon
```

启动后访问本地 Web 面板，可查看知识库总览、分组详情、手动编辑策略、清理弃用条目。

---

## License

MIT © [bsawang](https://github.com/bsawang)
