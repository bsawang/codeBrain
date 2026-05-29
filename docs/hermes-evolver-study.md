# Hermes & Evolver/GEP 借鉴研究

## Hermes (Nous Research)

**仓库**: github.com/NousResearch/hermes-agent, ~106k stars

### 核心设计

- **Memory**: `~/.hermes/memories/MEMORY.md` + `USER.md`，每个文件强制字符上限（2200/1375 chars），满了必须主动压缩
- **Skill**: 结构化目录，含 `SKILL.md` + `references/` + `templates/`，渐进式加载
- **Nudge Engine**: 每10轮用户对话/工具执行，后台 fork 一个独立 Agent 审查并更新记忆，用户无感

### 关键借鉴

1. **容量强制压缩**：知识注入不是越多越好，设定上限倒逼精炼
2. **后台异步学习**：学习不应该阻塞主 Agent 流程（我们已有异步深路径，方向对）
3. **前缀缓存稳定**：会话启动时冻结注入内容，避免每次改 system prompt 导致 KV cache 失效
4. **声明式事实**：注入知识用事实陈述（"该模式导致X错误"），不用命令（"必须改X"），Agent 才能根据上下文覆盖

### 不足

- 无跨项目知识转移
- 无置信度跟踪
- 无修复验证
- 学习成果在会话内不可用（冻结快照导致）

---

## Evolver + GEP (EvoMap)

**仓库**: github.com/EvoMap/evolver, GPL-3.0, ~7.5k stars
**论文**: arXiv 2604.15097 — "From Procedural Skills to Strategy Genes" (清华)

### 核心设计

**PCEC 循环**: SCAN → SIGNALS → SELECTION → MUTATION → PROMPT → SOLIDIFY

**GEP 协议**: LLM 必须按顺序输出 5 个 JSON：
1. Mutation（改了什么）
2. PersonalityState（调优参数）
3. EvolutionEvent（审计记录）
4. Capsule（执行记录+trace）
5. FilePatches（实际变更）

**核心概念**:
- **Gene**: ~230 token 的策略模板，结构 = signals_match + strategy steps + AVOID warnings + validation commands
- **Capsule**: "这个 Gene 在这个环境下成功了"，必须携带真实执行 trace（exit codes），杜绝凭空生成的假知识
- **PersonalityState**: 5 个浮点数维度（rigor/creativity/verbosity/risk_tolerance/obedience），基于成功/失败漂移
- **Event Tree**: append-only JSONL，每条有 parent ID，形成可追溯的变更树

### 关键发现（论文核心）

**230 token 的 Gene 优于 2500 token 的 Skill 文档。**
- 4590 次对照实验
- 详细文档反而降低通过率（60.1% → 50.7%）
- 策略基因提升性能（17.7% → 27.14%）
- **最优格式: 触发条件 + 修复步骤 + 避坑警告 — 其余都是噪音**

### 5层防循环机制

| 层级 | 触发条件 | 行为 |
|------|---------|------|
| 信号抑制 | 同一信号 8轮中出现 ≥3次 | 忽略该信号 |
| 修复循环检测 | 连续3次 repair | 强制注入 repair_loop_detected |
| 强制创新 | 连续修复后的下一轮 | 重新加权偏向 innovate(80%) |
| 饱和检测 | 连续3次零变更 | 触发 evolution_saturation |
| 稳态强制 | 连续5次零变更 | 完全暂停进化循环 |

### 关键借鉴

1. **最小信息原则**：注入的知识应该是"错误模式 + 修复策略 + 1条 AVOID 警告"，极紧凑
2. **防伪知识**：修复必须携带执行 trace（exit code、验证命令结果），不接受纯 LLM 生成的
3. **多层防循环**：必须设计防循环机制（同一错误反复注入修复 → 升级策略）
4. **置信度衰减**：长期未验证 → 置信度下降；3+ 次验证成功 → 置信度上升
5. **爆破半径估算**：注入修复时估算影响范围，超出阈值 → 降级为建议而非自动应用
6. **信号分类**：错误不只是指纹，还应分类（log_error / perf_bottleneck / capability_gap）

### 不足

- 过度工程化（简单 fix 也要走完整 GEP 协议）
- 关键词匹配基因，非语义匹配（我们 L1 embedding 更优）
- 不能自动创建新 Gene（需人工用 skill2gep）
- GPL-3.0 许可证
- 完整协议周期慢（不适合实时热修复）

---

## 与我们方案的对比（终版 v0.13）

| 维度 | Hermes | Evolver/GEP | **codebrain v0.13** |
|------|--------|-------------|---------------------|
| 部署 | 项目本地 | 全局/项目 | **系统级（~/.codebrain/）** |
| 触发 | 定时 nudge | 日志扫描 + signal | **实时 hook (PostToolUse)** |
| 采集 | 对话历史 | 日志文件 | **Agent 本就是采集器，无独立采集层** |
| 匹配 | 无 | 关键词 | **L0 哈希 + L1 embedding + L2 LLM** |
| 匹配耗时 | — | LLM 调用 (~s) | **< 5ms（本地，不碰网络）** |
| 注入时机 | 下个会话 | 协议 prompt | **本会话 hot-reload (< 5ms)** |
| 注入格式 | 自由文本 | Gene (~230t) | **极简模板 "fix+root+avoid" (~40t)** |
| 学习 | 后台 Nudge Agent | 协议约束的 LLM | **后台异步深路径（阶段1+2）** |
| 验证 | 无 | Capsule execution trace | **executionTrace (exit code 0)** |
| 防循环 | 防递归 fork | **5 层信号去重** | **3 档抑制（正常→降级→断供）** |
| 排序依据 | 无 | AI 置信度 0-1 | **verifiedCount（证据驱动）** |
| 版本感知 | 无 | 环境指纹 | **dependencyVersions 追踪 + 提醒** |
| 策略去重 | 无 | 无 | **语义合并版本范围** |
| 跨项目 | 无 | EvoMap 网络 | 后期云端 |
| 热更新 | 不支持 | 不支持 | **支持（内存索引入库即热）** |

## 借鉴 vs 自主选择

### 采纳的

| 来源 | 概念 | 我们的实现 |
|------|------|-----------|
| Evolver | 最小信息原则 | `fix + root + avoid` 极简注入 |
| Evolver | execution trace 验证 | 所有 Solution 必须带 exit code |
| Evolver | 防循环 | 3 档抑制 + 证据重置 |
| Evolver | 策略去重 | 同组同策略合并版本范围 |
| Hermes | 后台异步学习 | 深路径阶段1+2 异步执行 |
| Hermes | 声明式事实 | 注入用事实陈述，不用命令 |

### 刻意不采用的

| 来源 | 概念 | 理由 |
|------|------|------|
| Evolver | AI 置信度 (0-1) | 我们证据驱动，exit code 0 就是可信 |
| Evolver | PersonalityState 漂移 | 过度抽象，verifiedCount 更直接 |
| Evolver | 关键词匹配基因 | 我们有 L1 embedding，语义更强 |
| Evolver | 完整 GEP 协议 | 太重，简单 fix 不应走完整协议 |
| Evolver | 预置 Gene 资产池 | 我们从零生长，不需人工预置 |
| Hermes | 字符上限强制压缩 | 我们不是自由文本，模板本身就紧凑 |
| Hermes | 会话快照冻结 | 我们热更新才有价值，牺牲缓存稳定性换即时性 |
