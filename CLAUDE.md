# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个 OpenClaw LangSmith 追踪插件，用于将 OpenClaw agent 执行过程追踪到 LangSmith 平台。

- **技术栈**: TypeScript (ESM), Node.js >=22.14.0, pnpm
- **核心依赖**: langsmith SDK, openclaw Plugin SDK
- **插件类型**: OpenClaw 外部插件

## 构建与开发命令

```bash
# 安装依赖
corepack pnpm install

# 类型检查（不生成输出）
corepack pnpm check

# 构建项目（编译 TypeScript）
corepack pnpm build

# 运行测试
corepack pnpm test
```

构建输出目录: `dist/`

## 架构设计

### 核心模块职责

项目采用分层架构，每个模块职责单一：

1. **[src/index.ts](src/index.ts)** - 插件入口
   - 注册插件到 OpenClaw
   - 初始化 LangSmith 运行时
   - 注册 hook 处理器

2. **[src/config.ts](src/config.ts)** - 配置管理
   - 定义插件配置 schema
   - 解析和验证用户配置
   - 提供默认配置值

3. **[src/langsmith.ts](src/langsmith.ts)** - LangSmith SDK 边界
   - 动态加载 LangSmith SDK
   - 初始化 Client 和 RunTree
   - 隔离 SDK 依赖

4. **[src/tracer.ts](src/tracer.ts)** - 追踪状态机
   - 管理 root/llm/tool run 生命周期
   - 维护跨 hook 的内存状态
   - 处理 run 的创建、更新、结束

5. **[src/handlers/](src/handlers/)** - Hook 处理器
   - `llm.ts`: 处理 `llm_input` / `llm_output` 事件
   - `tool.ts`: 处理 `before_tool_call` / `after_tool_call` 事件
   - `transcript.ts`: 处理 `before_message_write` 事件,为可见 assistant 消息补充 transcript 级线索
   - `agent.ts`: 处理 `agent_end` 事件

6. **[src/types.ts](src/types.ts)** - 类型定义
   - 定义内部类型契约
   - 最小化对 OpenClaw API 的依赖

### 追踪流程

插件当前通过 6 个 OpenClaw hooks 维护追踪状态：

```
Root Run (agent turn)
├── Transcript-aware synthetic LLM run
├── Tool Run 1
├── Transcript-aware synthetic LLM run
├── Tool Run 2
└── ...
```

**Hook 触发顺序**:
1. `llm_input` → 创建 root run（如果不存在）+ 启动 LLM child run
2. `llm_output` → 结束当前 LLM attempt,并更新 root 输出摘要
3. `before_message_write` → 将 assistant 消息线索排队,供 tracer 物化 synthetic LLM 节点
4. `before_tool_call` → 在需要时先消费 transcript 队列,再启动 Tool child run
5. `after_tool_call` → 结束 Tool child run
6. `agent_end` → 延迟或立即结束 root run,并清理状态

### 关键设计原则

1. **Fail-open**: 追踪失败不影响 OpenClaw 主流程，所有 hook 处理器都有 try-catch
2. **状态隔离**: 使用 `openclawRunId` 作为 key 隔离不同 agent turn 的状态
3. **序列化执行**: 同一 `openclawRunId` 的操作通过队列串行执行，避免竞态
4. **Transcript-aware**: 通过 `before_message_write` 补足 LangSmith 中更接近人类阅读顺序的节点视图
5. **懒加载**: LangSmith SDK 在首次需要时才加载，配置错误不阻塞插件加载

## 配置说明

插件配置通过 OpenClaw 配置文件提供：

```typescript
{
  enabled: boolean;           // 是否启用追踪（默认 true）
  langsmithApiKey?: string;   // LangSmith API Key（必需）
  projectName?: string;       // 项目名称（默认 "openclaw"）
  debug?: boolean;           // 调试日志（默认 false）
}
```

环境变量支持:
- `LANGSMITH_API_KEY`: 可替代配置中的 `langsmithApiKey`

## 开发注意事项

### 修改追踪逻辑

- 修改 run 创建逻辑 → [src/tracer.ts](src/tracer.ts)
- 修改 hook 事件处理 → [src/handlers/](src/handlers/)
- 修改配置 schema → [src/config.ts](src/config.ts)

### 添加新的追踪字段

1. 在 [src/types.ts](src/types.ts) 中更新相关类型
2. 在 [src/tracer.ts](src/tracer.ts) 中更新 `buildBaseMetadata` 或相关 run 构建函数
3. 在对应的 handler 中传递新字段

### 调试

启用 debug 模式查看详细日志：

```typescript
{
  debug: true
}
```

日志会显示：
- 每个 hook 的触发
- Tracer 状态变化
- LangSmith SDK 初始化结果

## 重要约束

1. **不修改 OpenClaw 行为**: 插件只观察，不干预 agent 执行
2. **TypeScript strict 模式**: 所有代码必须通过严格类型检查
3. **ESM 模块**: 使用 `import/export`，不使用 `require`
4. **Node.js 版本**: 最低 22.14.0
5. **编码规范**: 遵循项目 tsconfig.json 配置

## 相关文档

- [ARCHITECTURE.md](ARCHITECTURE.md) - 详细架构设计文档
- [package.json](package.json) - 依赖和脚本配置
- [tsconfig.json](tsconfig.json) - TypeScript 编译配置
