# OpenClaw LangSmith Tracing Plugin

面向 OpenClaw 的 LangSmith 追踪插件，用来把一次 agent turn 里的关键执行链路投影到 LangSmith，帮助排查失败原因、理解模型与工具调用顺序，并为后续性能分析和产品迭代留出扩展空间。

An external OpenClaw plugin that projects one agent turn into LangSmith so you can inspect execution flow, tool usage, and assistant-visible progress without changing OpenClaw core code.

## 为什么做这个项目

OpenClaw 已经具备完整的 agent loop，但默认缺少面向 LangSmith 的结构化 trace 视图。实际排查问题时，经常会遇到几个痛点：

- 一轮执行失败后，很难快速判断问题发生在模型阶段、工具阶段，还是消息写入阶段。
- 工具调用和 assistant 可见输出之间的关系不够直观，排查成本高。
- 即使已有详细日志，也不容易获得一个适合产品和工程共同阅读的执行树。

这个项目的目标不是做一个“大而全”的可观测平台，而是先建立一个最小可用、可持续演进的 tracing 基础设施。

## 核心能力

- 基于 OpenClaw Plugin Hooks 接入，不修改 OpenClaw 核心代码。
- 以 `openclaw.agent_turn` 作为根节点，追踪一次 agent turn 的完整生命周期。
- 结合 `before_message_write` 线索，补充 transcript-aware 的 synthetic LLM 节点，让 LangSmith 中的阅读顺序更贴近真实对话过程。
- 记录工具调用的输入、输出、错误与耗时，便于定位失败步骤。
- 全链路保持 fail-open，追踪失败不会阻塞主业务流程。

## 当前实现亮点

- 跨 hook 状态机：在 `src/tracer.ts` 中维护多张索引表，把离散 hook 事件串成一个稳定的运行时模型。
- Transcript-aware tracing：使用 `before_message_write` 将可见 assistant 消息物化为 synthetic LLM 节点。
- Tool bucket/stack 模式：处理同名工具并发调用，降低错配风险。
- 文档驱动实现：仓库内保留了 [PRD.md](./PRD.md) 和 [ARCHITECTURE.md](./ARCHITECTURE.md)，可以看到设计与实现的真实演进关系。

## 仓库结构

```text
.
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── langsmith.ts
│   ├── tracer.ts
│   ├── types.ts
│   └── handlers/
│       ├── agent.ts
│       ├── llm.ts
│       ├── tool.ts
│       └── transcript.ts
├── test/
├── PRD.md
├── ARCHITECTURE.md
├── CLAUDE.md
└── openclaw.plugin.json
```

## 环境要求

- Node.js `>= 22.14.0`
- `corepack`
- 与 `package.json` 中 `peerDependencies` 兼容的 OpenClaw 版本

## 安装与构建

```bash
corepack pnpm install
corepack pnpm check
corepack pnpm build
corepack pnpm test
```

## 快速开始

1. 在 OpenClaw 中安装或本地链接本插件。
2. 在 OpenClaw 的插件配置里启用插件并提供 LangSmith API Key。
3. 触发一轮普通问答和一轮包含工具调用的问答。
4. 打开 LangSmith，检查是否出现对应的 root run、synthetic LLM 节点和 tool run。

一个最小配置示例如下：

```json
{
  "plugins": {
    "entries": {
      "openclaw-langsmith": {
        "enabled": true,
        "config": {
          "enabled": true,
          "langsmithApiKey": "${LANGSMITH_API_KEY}",
          "projectName": "openclaw",
          "debug": false
        }
      }
    }
  }
}
```

## 配置说明

| 字段 | 说明 | 默认值 |
| --- | --- | --- |
| `enabled` | 插件总开关 | `true` |
| `langsmithApiKey` | LangSmith API Key | 无 |
| `projectName` | LangSmith 中显示的项目名 | `openclaw` |
| `debug` | 是否输出额外调试日志 | `false` |

## 架构概览

当前实现里最重要的几个运行时角色是：

- Root Run：代表一次 OpenClaw agent turn。
- LLM attempt state：记录 coarse-grained 的模型阶段上下文。
- Synthetic LLM run：从 transcript 里的 assistant 可见消息重建出来的 LangSmith 节点。
- Tool Run：记录一次工具调用。

更完整的设计与实现说明见：

- [PRD.md](./PRD.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [CLAUDE.md](./CLAUDE.md)

## 测试与质量保证

仓库已补充基础自动化校验：

- `corepack pnpm check`：TypeScript 严格类型检查
- `corepack pnpm build`：编译构建
- `corepack pnpm test`：Node 原生测试运行器执行基础单元测试
- `.github/workflows/ci.yml`：在 GitHub Actions 中自动执行以上步骤

## 关于 `self-learn-src/`

仓库中保留了 `self-learn-src/` 目录，用来展示早期原型验证过程。它不是正式实现，正式代码以 `src/` 为准。

## 贡献指南

欢迎通过 Issue 或 Pull Request 讨论以下方向：

- 进一步增强 transcript-aware tracing
- 补充更多测试覆盖
- 增加示例配置和 smoke test 文档
- 扩展更多 OpenClaw hooks 的观测能力

## License

本项目使用 [MIT License](./LICENSE)。
