# 竞品调研报告 — 开发错误自动收集与 AI 自进化框架

调研日期：2026-05-29

---

## 一、核心结论

**没有产品完成"错误采集 → 指纹化 → AI上下文注入 → AI自动进化"整条链路。** 四个环节各自有零散项目，但无整合者。

---

## 二、最接近的 3 个项目

### 2.1 No-No Debug

- **URL**: https://github.com/summerliuuu/no-no-debug
- **类型**: Claude Code Skill
- **做了什么**: 跨会话错误记忆，记录编译错误/测试失败/用户纠正 → 累积预防规则 → 每3天定期review
- **效果**: 真实数据 第1周29个错误 → 第3周接近0错误
- **缺了什么**: 
  - 无结构化指纹（简单规则累积）
  - 无多源采集（仅绑 Claude Code）
  - 无向量搜索
  - 无团队共享

### 2.2 ELF (Emergent Learning Framework)

- **URL**: https://github.com/Spacehunterz/Emergent-Learning-Framework_ELF
- **类型**: 多 Agent 记忆框架
- **做了什么**: 
  - 置信度评分启发式（0.0 → 1.0）
  - 失败和成功记录到 SQLite
  - 高置信度模式自动提升为 Golden Rules
  - Pheromone Trails（文件热点分析）
  - 多 Agent Swarm 协调
- **缺了什么**:
  - 通用记忆系统，非错误专用
  - 无自动错误采集
  - 无错误指纹化

### 2.3 ACE (Agentic Context Engineering)

- **URL**: https://arxiv.org/abs/2510.04618
- **类型**: 学术论文 (ICLR 2026, SambaNova + Stanford + UC Berkeley)
- **做了什么**: 三角色架构
  - Generator（执行任务）
  - Reflector（分析成功/失败）
  - Curator（合成结构化 Playbook 条目）
  - 增量 delta 更新防止"上下文崩塌"
- **效果**: 复杂 Agent 任务平均 +10.6%，适应延迟降低 86.9%
- **缺了什么**:
  - 面向通用 Agent 任务，不针对开发错误
  - 不自动采集开发工具链错误
  - 纯学术框架

---

## 三、直接竞品：@evomap/evolver

- **URL**: https://github.com/EvoMap/evolver
- **npm**: `@evomap/evolver`（12K+ 月下载，70+ 版本）
- **许可证**: GPL-3.0（原 MIT，因竞品抄袭而修改）
- **核心机制**: 
  - GEP (Genome Evolution Protocol) 协议
  - 分析 `./memory/` 目录中的错误模式
  - 从预置资产池中选择 Genes 和 Capsules
  - 输出 GEP 协议提示词
  - Git 追踪变更 + 自动回滚
  - 信号去重防止修复循环
- **安全**: 曾披露多个 CVE（RCE via command injection、path traversal），v1.66.5+ 已修复
- **与我们的差异**: 
  - Evolver = **预置资产 + 提示词生成**（需要预先构建 gene/capsule 资产）
  - 我们 = **从原始错误中自动指纹化 + 生长知识**（无需预置资产，从零学习）

---

## 四、AI 编码助手记忆类（社区方案）

| 项目 | 存储 | 错误专用？ | AI自进化？ |
|------|------|-----------|-----------|
| STM2 | SQL.js WASM Graph | 部分 | 部分（写入CLAUDE.md） |
| claude-brain | SQLite FTS | 否 | 否 |
| Sugar | SQLite | 是（error_pattern类型） | 否（手动召回） |
| In-Memoria | SQLite + SurrealDB | 否 | 部分（模式学习） |
| Cursor Brain | SQLite FTS5 | 否 | 否 |
| Memory-Token | JSON + RAG SQLite | 否 | 否（人工审核） |
| Copilot Memory Bank | Markdown | 否 | 否 |

**共性缺陷**：全部是通用记忆系统。无自动错误采集、无错误指纹化、无团队共享。

---

## 五、自进化编码类（学术/实验项目）

### LLMLOOP (ICSME 2025)
- 五阶段迭代：编译错误→测试失败→静态分析→测试生成→变异分析
- Pass@10 从 76% 提升到 90%
- **局限**：学术框架，无持久跨会话记忆，仅 Java

### Reflexion (NeurIPS 2023)
- 三角色架构（Actor、Evaluator、Self-Reflection）+ 长期记忆
- GPT-4 代码生成提升 21%
- **局限**：需微调模型，非开发工具链集成

### REAP (Recursive Evolutionary Autonomous Pipeline)
- npm: `@c-d-cc/reap`
- 基因/环境协同进化，五阶段生命周期
- **局限**：架构级进化，不追踪开发期错误

### ShinkaEvolve (Sakana AI, ICLR 2026)
- 岛屿种群 + UCB1 bandit 选择
- **局限**：离线批量优化，非实时开发工作流

### WebCoach (UCLA + Amazon, Nov 2025)
- 跨会话 Web Agent 记忆：WebCondenser + FAISS + Coach
- 关键洞察：Agent 从**自己的轨迹**中学习效果最好
- **局限**：Web Agent 领域，非代码开发

---

## 六、DevOps/CI 错误聚合类

### Block "Actionable CI" (Square)
- 三层 CI 失败聚合：静态模式 → LLM 分组 → AI Agent 自动修复
- **局限**：仅 CI 环境，不采集本地开发错误

### Gradle Develocity Failure Analytics
- 企业级构建失败聚合（本地 + CI）
- AI 分组常见失败，Criteo 从 30分钟降到 30秒
- **局限**：纯构建层面，无 AI 学习闭环

---

## 七、知识库/经验共享类

### Stack Overflow for Teams
- 私有 Elasticsearch + OverflowAI 语义搜索 + MCP Server
- AI Agent 可查询和贡献
- **局限**：人工录入，无自动错误采集，无指纹化

### ShareXP
- 本地优先的解决方案数据库
- 混合搜索（全文 + 向量）+ 信任排名
- **局限**：手动录入

---

## 八、空白总结

| 能力 | 最接近现有方案 | 空白 |
|------|---------------|------|
| 多源自动错误采集 | No-No Debug（仅 Claude Code，简单日志） | 无多源统一采集器 |
| 错误结构化指纹 | error-rail（通用 Rust lib） | 无开发错误专用指纹引擎 |
| 跨会话持久错误索引 | Sugar、ELF（通用记忆） | 无错误专用持久索引 + 相似搜索 |
| 团队知识共享 | Stack Overflow Teams、ShareXP | 需手动录入，无自动化 |
| AI 上下文注入 | ACE（Playbook 架构，通用任务） | 无面向代码 Agent 的错误 Playbook |
| 跨会话学习闭环 | LLMLOOP（单次会话内） | 无跨会话闭环 |

**四条空白连起来 = 我们的机会空间。**

---

## 九、参考项目索引

| 项目 | URL |
|------|-----|
| No-No Debug | https://github.com/summerliuuu/no-no-debug |
| ELF | https://github.com/Spacehunterz/Emergent-Learning-Framework_ELF |
| Sugar | https://github.com/roboticforce/sugar |
| @evomap/evolver | https://github.com/EvoMap/evolver |
| ACE Paper | https://arxiv.org/abs/2510.04618 |
| ReflexiCoder | https://arxiv.org/abs/2603.05863 |
| LLMLOOP | https://arxiv.org/abs/2603.23613 |
| Block Actionable CI | https://engineering.block.xyz/blog/actionable-ci |
| Gradle Develocity | https://gradle.com/develocity/product/failure-analytics/ |
