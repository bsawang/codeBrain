# VSCode \+ Claude Code \+ DeepSeek 适配 Evolver\+GEP 自进化落地教程

## 一、核心适配结论（适配你的环境）

你的当前栈：**VSCode 编辑器 \+ Claude Code（编码 Agent）\+ DeepSeek（底层模型）**

✅**完全原生适配、无需改工作流、无需切换模型**

Evolver 官方内置 **Claude Code 专属 Hook**，可以直接接管你的编码全流程：

- 自动记录每一次代码生成、修改、报错、人工纠正

- 基于 GEP 协议沉淀 **编码基因（Gene）\+ 项目技能胶囊（Capsule）**

- 自动优化 Claude Code 提示词、编码风格、排错逻辑、工程规范

- 全程保留 DeepSeek 模型推理，进化层外挂叠加，不替换原有模型

## 二、整体架构（你的最终形态）

**原有主链路（不变）**：VSCode → Claude Code 插件 → DeepSeek 模型 正常编码工作

**新增进化链路（外挂旁路）**：任务轨迹采集 → Evolver GEP 引擎复盘 → 沉淀编码规则 → 下次编码自动生效优化

特点：**主工作流零感知、零卡顿、零侵入，只进化不破坏**。

## 三、极速部署步骤（5分钟完成）

### 步骤1：全局安装 Evolver 官方引擎

打开 VSCode 终端，执行安装：

```Plain Text
npm install -g @evomap/evolver
```

验证安装成功：

```Plain Text
evolver --version
```

### 步骤2：一键绑定 Claude Code 工作流（核心命令）

Evolver 内置官方适配钩子，直接对接 Claude Code 日志与会话：

```Plain Text
evolver setup-hooks --platform=claude-code
```

执行效果：

- 自动生成 Claude Code 监听钩子

- 绑定当前项目为 GEP 进化仓库

- 开启编码行为全量轨迹采集

### 步骤3：初始化 GEP 进化仓库

在你的项目根目录执行：

```Plain Text
evolver init
```

生成标准 GEP 目录结构：

- `\.gep/genes/`：编码规则基因库（自动积累）

- `\.gep/capsules/`：项目级编码技能胶囊

- `\.gep/events/`：所有进化审计日志

### 步骤4：适配 DeepSeek 模型（无需替换，仅标记）

你的 Claude Code 原本调用 DeepSeek，无需改动模型配置，仅需给进化层标记模型来源，让复盘更精准：

```Plain Text
evolver config set --llm=deepseek
```

作用：Evolver 会针对 DeepSeek 的编码特点、输出风格、易错点做**定向进化优化**。

### 步骤5：重启 VSCode \+ Claude Code 生效

完全重启 VSCode，重新打开 Claude Code 会话，接入完成。

## 四、日常使用方式（完全无感自动进化）

### 1\. 正常使用不变

你依然正常在 VSCode 用 Claude Code 对话、改代码、调试、写逻辑，底层依旧走 DeepSeek 推理。

### 2\. 自动后台进化（全程静默）

每完成一次编码任务、一次报错修复、一次人工修正，Evolver 自动异步执行：

- 采集本次编码轨迹（prompt、代码、报错、修改记录）

- 复盘优劣：哪里写得冗余、哪里逻辑漏判、哪里适配不规范

- 沉淀 Gene：固化本次最优编码规则、避坑规则

- 合并 Capsule：针对当前项目技术栈，沉淀专属开发技能

### 3\. 手动触发深度进化（推荐每日一次）

终端执行深度复盘，批量优化规则、清理无效基因、升级项目技能：

```Plain Text
evolver evolve
```

## 五、四种进化模式适配你的开发场景

可随时切换，适配不同开发阶段：

- **开发阶段（innovate）**：大胆优化写法、探索更优工程实现

- **日常迭代（balanced 默认）**：平衡创新与稳定

- **修 Bug 阶段（harden）**：专注纠错、规避重复问题

- **上线稳定期（stable）**：只修致命错误，不改动编码风格

切换命令示例：

```Plain Text
evolver mode innovate
```

## 六、你将获得的具体进化能力（针对编码场景）

- **自动统一项目代码风格**：自动纠正不统一的命名、缩进、结构、注释规范

- **消灭重复 Bug**：DeepSeek 经常犯的同类逻辑错误、边界遗漏，自动形成规避基因，永不重复犯错

- **项目专属技能沉淀**：针对你的项目技术栈（Vue/React/Go/Java 等）沉淀专属编码胶囊，越写越贴合项目架构

- **自动优化 Prompt 策略**：无需手动改 Claude Code 指令，系统自动优化提问方式、约束条件、输出要求

- **全流程可审计**：每一次代码优化、规则变更都有 GEP 事件记录，支持回滚、溯源

## 七、关键注意事项（避坑）

- 无需断开 DeepSeek，**模型链路完全保留**，进化只做后置复盘，不替换推理模型

- 不修改 Claude Code 插件源码，纯 Hook 旁路监听，升级、卸载无残留

- 进化数据全部本地化存储在项目 `\.gep` 目录，隐私安全可控

- 首次接入前 10–20 次编码会快速积累基因，后续智能优化效果会肉眼可见

## 八、接入成功验证标准

执行一次编码修改后，查看是否自动生成进化资产：

```Plain Text
evolver status
```

出现基因更新、事件记录即代表**完全接入成功**，你的 VSCode\+Claude\+DeepSeek 工作流正式进入自进化闭环。

> （注：文档部分内容可能由 AI 生成）
