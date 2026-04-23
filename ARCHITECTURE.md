# OpenClaw LangSmith Tracing Plugin V1 Architecture

## 1. 文档角色

本文档是 V1 实现方案、工程决策和开发顺序的单一信息源。

本文档回答的问题是：

- 这个插件在工程上怎么实现
- 为什么只选这几个 hooks
- 内部状态怎么管理
- 代码结构怎么拆
- 测试怎么做
- 一个新工程师拿到文档后，应该按什么顺序开始开发

产品边界、成功标准和用户价值见同目录的 [PRD.md](./PRD.md)。

## 2. 方案总览

V1 方案采用：

- **外部独立插件仓库**
- **TypeScript ESM**
- **LangSmith JS SDK**
- **OpenClaw Plugin hooks**

核心思路是：

1. 只接 V1 需要的五个 hooks
2. 用插件自己的内存状态把多次 hook 触发串成一棵 RunTree
3. 使用 LangSmith 的 `RunTree` API 创建 root / child runs
4. 全程 fail-open，禁止 tracing 影响 OpenClaw 主流程

## 3. 关键技术决策

### 3.1 决策：使用独立仓库

原因：

- 这是一个外部插件，不属于 OpenClaw 核心仓库
- 便于独立版本管理
- 便于独立发 npm / ClawHub
- 避免把实验代码混进 OpenClaw 主仓库

### 3.2 决策：使用 TypeScript 而不是 Python

原因：

- OpenClaw 原生插件入口是 JS/TS 模块
- Plugin SDK 的入口与 typed hooks 都以 TS/JS 为标准形态
- 可直接消费 `api.on(...)`

### 3.3 决策：只接五个 hooks

V1 只接入：

- `llm_input`
- `llm_output`
- `before_tool_call`
- `after_tool_call`
- `agent_end`

原因：

- 这是拼出最小 trace 树所需的最短路径
- 这五个 hooks 最接近主 agent-loop
- 它们已经足够表达 Root / LLM / Tool 三层结构

### 3.4 决策：用插件内部状态跨 hook 串联

原因：

- `event` 和 `ctx` 是每个 hook 点位的一次性快照，不是共享可变对象
- 要把多个 hooks 串成一棵树，必须由插件自己维护关联状态

### 3.5 决策：fail-open

原因：

- tracing 不是主业务
- OpenClaw 主流程稳定性优先于 tracing 完整性

要求：

- hook handler 内不能向外抛异常
- LangSmith 请求失败只记日志，不阻断运行
- 尤其是 `before_tool_call`，必须保持轻量和安全

## 4. 外部依赖与假设

### 4.1 OpenClaw 侧假设

实现基于以下假设：

- OpenClaw 支持通过 `api.on(hookName, handler)` 注册 typed lifecycle hooks
- OpenClaw 会按约定向 hook handler 传入 `(event, ctx)`
- V1 所需五个 hooks 均在目标 OpenClaw 版本可用

### 4.2 LangSmith 侧假设

实现基于以下假设：

- 使用 LangSmith JS SDK
- 使用 `RunTree` 进行显式建树
- 使用以下顶层字段：
  - `name`
  - `run_type`
  - `inputs`
  - `outputs`
  - `error`
  - `metadata`
  - `tags`
  - `project_name`
- 使用以下核心方法：
  - `createChild()`
  - `postRun()`
  - `end()`
  - `patchRun()`

### 4.3 插件仓库侧假设

独立仓库中不再包含 OpenClaw 源码。

因此实现文档必须自己包含：

- V1 所需 hook 的数据契约
- 关键模块划分
- 开发顺序
- 测试策略

## 5. V1 hook 数据契约

以下内容是实现 V1 所必需的最小 hook 契约摘要。

### 5.1 `llm_input`

`event`

```ts
{
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
}
```

`ctx`

```ts
{
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
}
```

### 5.2 `llm_output`

`event`

```ts
{
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}
```

`ctx`

与 `llm_input` 的 `ctx` 同类。

### 5.3 `before_tool_call`

`event`

```ts
{
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}
```

`ctx`

```ts
{
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}
```

### 5.4 `after_tool_call`

`event`

```ts
{
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}
```

`ctx`

与 `before_tool_call` 的 `ctx` 同类。

### 5.5 `agent_end`

`event`

```ts
{
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
}
```

`ctx`

```ts
{
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
}
```

## 6. RunTree 设计

### 6.1 Root Run

用途：

- 表示一整轮 OpenClaw agent turn

固定字段：

```ts
name = "openclaw.agent_turn"
run_type = "chain"
project_name = <config.projectName>
```

建议写入：

- `metadata`
  - `openclawRunId`
  - `sessionId`
  - `sessionKey`
  - `agentId`
  - `channelId`
  - `trigger`
- `outputs`
  - `success`
  - `error`
  - `durationMs`
  - `messageCount`

明确决策：

- V1 不要求把 `event.messages` 整体原样上传到 Root Run
- 当前实现中，Root Run 的 `inputs` 会在首个 `llm_input` 到达后补写
- 当前实现中，Root Run 的 `outputs` 会在最后一个成功结束的 `llm_output` 到达后覆盖为最新值

### 6.2 LLM Child Run

用途：

- 表示一次模型调用

固定字段：

```ts
name = "openclaw.llm"
run_type = "llm"
```

建议写入：

- `inputs`
  - `prompt`
  - `systemPrompt`
  - `historyMessages`
  - `imagesCount`
- `outputs`
  - `assistantTexts`
  - `lastAssistant`
- `metadata`
  - `openclawRunId`
  - `sessionId`
  - `sessionKey`
  - `provider`
  - `model`
  - `llmSequence`
- `tags`
  - `openclaw`
  - `llm`
  - `provider:<provider>`
  - `model:<model>`

当前实现补充：

- 当前插件中的一个 `openclaw.llm` 节点，对应的是一次外层 OpenClaw LLM attempt
- 它不是“每次工具调用之间那一小段回复”的天然一一映射
- 在当前 OpenClaw 宿主语义下，同一个 LLM attempt 里可能累积多段 assistant 可见回复，这些内容会一起出现在 `assistantTexts`

### 6.3 Tool Child Run

用途：

- 表示一次工具调用

固定字段：

```ts
name = `openclaw.tool.${toolName}`
run_type = "tool"
```

建议写入：

- `inputs`
  - `toolName`
  - `params`
- `outputs`
  - `result`
- `error`
  - `error`
- `metadata`
  - `openclawRunId`
  - `sessionId`
  - `sessionKey`
  - `toolCallId`
  - `durationMs`
- `tags`
  - `openclaw`
  - `tool`
  - `tool:<toolName>`

当前实现补充：

- Tool Child Run 当前不直接挂在 Root Run 下
- Tool Child Run 会挂在“当前活跃的 LLM Child Run”之下
- 这样至少能保证工具调用属于哪一次外层 LLM attempt 是清晰的

## 7. 状态管理设计

因为 `event` 和 `ctx` 是一次性快照，插件必须自己维护跨 hook 的关联状态。

### 7.1 Root Run 索引

```ts
Map<string, RunTree>
// key = openclawRunId
```

用途：

- 按 `runId` 找到本轮 Root Run

### 7.2 LLM Run 索引

```ts
Map<string, RunTree>
// key = `${openclawRunId}:${llmSequence}`
```

用途：

- 同一轮可能有多次 LLM 调用
- 不能只按 `runId` 存一个 LLM Run

### 7.3 LLM 序号索引

```ts
Map<string, number>
// key = openclawRunId
```

用途：

- 每次 `llm_input` 到来时为该轮分配一个递增序号

### 7.4 Tool Run 索引

```ts
Map<string, RunTree>
// key 优先 toolCallId
// fallback = `${openclawRunId}:${toolName}:${sequence}`
```

用途：

- 在 `after_tool_call` 中找到对应 Tool Run

### 7.5 当前活跃 LLM 指针

```ts
Map<string, string>
// key = openclawRunId
// value = 当前活跃 llmKey
```

用途：

- 显式记录“本轮当前正在进行的 LLM Child Run”
- `before_tool_call` 只允许挂到当前活跃的 LLM Child Run 下
- 避免工具节点错误地挂到 Root Run 或旧的 LLM Run 下

### 7.6 延迟 Root 收尾状态

```ts
Map<string, FinishRootRunParams>
// key = openclawRunId
```

用途：

- `agent_end` 可能先于最后一个 `llm_output` 或 `after_tool_call` 到达
- 当前实现不会立即结束 Root Run，而是先缓存收尾参数
- 只有当活跃 LLM / Tool 节点全部结束后，才真正执行 Root Run 的 `end()` + `patchRun()`

### 7.7 单轮串行事件队列

```ts
Map<string, Promise<void>>
// key = openclawRunId
```

用途：

- OpenClaw hook 调用是 fire-and-forget 的，不能假设异步上报完成顺序等于事件到达顺序
- 当前实现按 `openclawRunId` 串行化 tracer 里的状态变更
- 目标是避免父子关系因为异步竞争而串树

## 8. 模块划分

建议的仓库结构如下：

```text
openclaw-langsmith-plugin/
├─ package.json
├─ openclaw.plugin.json
├─ tsconfig.json
├─ src/
│  ├─ index.ts
│  ├─ config.ts
│  ├─ logger.ts
│  ├─ langsmith.ts
│  ├─ tracer.ts
│  ├─ types.ts
│  └─ handlers/
│     ├─ llm.ts
│     ├─ tool.ts
│     └─ agent.ts
└─ test/
   ├─ config.test.ts
   ├─ tracer.test.ts
   ├─ llm-hooks.test.ts
   ├─ tool-hooks.test.ts
   └─ agent-end.test.ts
```

### `src/index.ts`

职责：

- 注册 hook
- 初始化 config / logger / client / tracer
- 组合 handler

### `src/config.ts`

职责：

- 解析插件配置
- 提供默认值
- 做基础校验

### `src/langsmith.ts`

职责：

- 初始化 LangSmith Client
- 提供 `createRunTreeClient()` 之类的封装

### `src/tracer.ts`

职责：

- 管理 Root / LLM / Tool Run 的创建、结束和索引
- 对外暴露核心动作：
  - `ensureRootRun`
  - `startLlmRun`
  - `finishLlmRun`
  - `startToolRun`
  - `finishToolRun`
  - `finishRootRun`

### `src/handlers/*`

职责：

- 只负责消费 `event` / `ctx`
- 从 hook 输入转成 tracer 调用
- 做最小错误保护

## 9. 运行流程

### 9.1 LLM 路径

1. 收到 `llm_input`
2. 根据 `event.runId` 确保 Root Run 存在
3. 如果 Root Run 还没有 `inputs`，则用首个 `llm_input` 补写 Root Run `inputs`
4. 创建 LLM Child Run
5. 写入 LLM 索引并 `postRun()`
6. 标记该 LLM 为当前活跃 LLM
5. 收到 `llm_output`
6. 找到当前活跃的 LLM Child Run
7. 用该次 `llm_output` 覆盖 Root Run `outputs`
8. `end()` + `patchRun()`
9. 清理该 LLM 索引

### 9.2 Tool 路径

1. 收到 `before_tool_call`
2. 根据 `event.runId` 确保 Root Run 存在
3. 找到当前活跃的 LLM Child Run
4. 创建 Tool Child Run，并把它挂在该 LLM Child Run 下
5. 写入 Tool 索引并 `postRun()`
6. 收到 `after_tool_call`
7. 用 `toolCallId` 或 fallback key 找到 Tool Child Run
8. `end()` + `patchRun()`
9. 清理该 Tool 索引

### 9.3 Root 收尾路径

1. 收到 `agent_end`
2. 暂存 Root Run 收尾参数，而不是立刻结束 Root Run
3. 等活跃 LLM / Tool 全部结束后，再写入结果字段
4. `end()` + `patchRun()`
5. 清理该 run 关联的内存状态

## 10. Hook 到实现动作的映射

### `llm_input`

实现动作：

- 校验配置与 client 是否可用
- `ensureRootRun()`
- `startLlmRun()`

### `llm_output`

实现动作：

- `finishLlmRun()`

### `before_tool_call`

实现动作：

- `ensureRootRun()`
- `startToolRun()`

### `after_tool_call`

实现动作：

- `finishToolRun()`

### `agent_end`

实现动作：

- `finishRootRun()`

### 当前实现补充（2026-04-11）

当前代码已经完成并验证了以下行为：

- 插件已实现 `llm_input`、`llm_output`、`before_tool_call`、`after_tool_call`、`agent_end` 五个 hook
- Root Run 的 `inputs` 与首个 `llm_input` 对齐
- Root Run 的 `outputs` 与最后一个 `llm_output` 对齐
- Tool Run 当前作为活跃 LLM Run 的 child，而不是 Root Run 的 child
- `agent_end` 提前到达时，Root Run 会延迟收尾，直到子节点完成
- 每次 `postRun()`、`patchRun()`、`end()` 后会尽量 flush LangSmith client 的待发批次
- 同一 `openclawRunId` 下的 tracer 状态变更按顺序串行执行，避免异步乱序导致树结构错误

已确认的宿主语义限制：

- OpenClaw 当前只在外层 attempt 边界触发 `llm_input` / `llm_output`
- 一次正常的“工具调用后继续回答”流程，常常仍然只对应一个 `openclaw.llm` 节点
- `assistantTexts` 是该次 attempt 内多段 assistant 可见回复的聚合数组

这意味着当前 LangSmith 树的真实语义是：

- `openclaw.llm` 更像“外层一次模型 attempt”
- 而不是“每一次工具结果之后的单独思考节点”

### 下一步可选方案：`assistant_step` 子节点

如果后续需要提升 LangSmith 上的可读性，更合理的方向不是伪造更多 `openclaw.llm` 节点，而是：

1. 保留当前 `openclaw.llm` 作为真实外层 attempt
2. 在该节点下新增 `assistant_step` 子节点
3. 每出现一段新的 assistant 可见回复，就新建一个 `assistant_step`
4. 把随后发生的 Tool Run 挂到对应 `assistant_step` 下

候选数据来源：

- `api.runtime.events.onAgentEvent(...)`
- `api.runtime.events.onSessionTranscriptUpdate(...)`

这样做的好处：

- 不会伪造额外的模型调用次数
- 能更直观看到“某段回复之后调用了哪些工具”
- 能把当前 `assistantTexts` 的聚合展示，重建成更符合人类阅读习惯的顺序树

为什么暂不实现：

- 这已经超出 V1 只依赖五个标准 hooks 的边界
- 需要额外处理事件流去重、assistant 文本归并、step 收尾时机等新状态机问题
- 当前 V1 已经满足最小 trace 产品目标，因此先记录方案，按需再做

## 11. 错误处理策略

### 11.1 总体原则

全部 tracing 逻辑采用 fail-open。

具体要求：

- hook handler 内部使用 `try/catch`
- 不向 OpenClaw 主链抛异常
- 只记录 `warn` / `error` 日志

### 11.2 LangSmith 网络失败

策略：

- 记录日志
- 放弃当前上报
- 不阻断 OpenClaw 主流程

### 11.3 敏感 hook 保护

`before_tool_call` 最敏感。

要求：

- 不执行重计算
- 不做复杂序列化
- 不抛异常
- 只做最小 run 创建与状态登记

## 12. 配置设计

V1 最小配置：

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

字段说明：

- `enabled`: 插件总开关
- `langsmithApiKey`: LangSmith API key
- `projectName`: LangSmith 项目名
- `debug`: 调试日志开关

## 13. 推荐开发顺序

这是给新工程师最重要的一节。

### Phase 1：仓库与骨架

目标：

- 新建独立仓库
- 补齐 `package.json`、`openclaw.plugin.json`、`tsconfig.json`
- 插件能被 OpenClaw 以本地链接方式加载

产出：

- 最小可加载插件

### Phase 2：配置与 LangSmith 封装

目标：

- 完成 `config.ts`
- 完成 `langsmith.ts`
- 让插件在有/无配置时都有明确行为

产出：

- 可初始化的 client

### Phase 3：先做 `tracer.ts`

目标：

- 完成状态 map
- 定义 tracer API
- 先用单元测试把状态管理测住

原因：

- 真正复杂的不是 hook 注册，而是跨 hook 状态关联

### Phase 4：先实现 LLM 闭环

目标：

- 只实现 `llm_input` / `llm_output`
- 跑通 `Root + LLM Child`

原因：

- 这是最小可见成果
- 最容易在 LangSmith UI 中验证

### Phase 5：再实现 Tool 闭环

目标：

- 实现 `before_tool_call` / `after_tool_call`
- 跑通 Tool Child Run

### Phase 6：最后补 `agent_end`

目标：

- Root Run 能正确结束
- 状态能被清理

### Phase 7：联调与收尾

目标：

- 本地链接安装
- Smoke test
- README / 配置示例 / 发布准备

## 14. 测试策略

### 14.1 先写什么测试

建议不是先写端到端测试，而是先写：

- `tracer.ts` 单元测试
- hook handler 单元测试

最值得先测试的是：

- Root Run 是否只创建一次
- 同一轮多次 LLM 调用能否正确分配序号
- Tool Run 能否正确配对
- `agent_end` 能否正确清理状态
- 失败时是否 fail-open

### 14.2 测试分层

#### A. 配置测试

测试：

- 缺少 `langsmithApiKey`
- `enabled=false`
- 默认 `projectName`

#### B. Tracer 单元测试

测试：

- `startLlmRun()`
- `finishLlmRun()`
- `startToolRun()`
- `finishToolRun()`
- `finishRootRun()`

这里不真连 LangSmith，直接 mock：

- `createChild`
- `postRun`
- `end`
- `patchRun`

#### C. Hook handler 单元测试

测试：

- handler 是否从 `event` / `ctx` 取对字段
- 是否把参数正确传给 tracer
- 是否不会向外抛异常

#### D. 本地 smoke test

真实做一次：

- 本地链接安装插件
- 触发一次普通问答
- 触发一次包含工具调用的问答
- 检查 LangSmith UI 是否出现 Root / LLM / Tool 树

### 14.3 推荐命令

仓库内推荐命令由插件仓库自行定义，但建议至少有：

```bash
npm test
npm run build
npm run check
```

## 15. 本地联调方式

推荐方式：

```bash
openclaw plugins install -l <your-plugin-repo>
```

这样可以：

- 独立开发插件
- 同时真实接到本机 OpenClaw 上
- 快速做 smoke test

## 16. 发布策略

建议顺序：

1. 先本地链接开发
2. 再做私有 npm 包或本地 tgz 测试
3. 最后再决定是否发布到 npm / ClawHub

V1 阶段不需要先把发布流程做复杂。

## 17. 风险与缓解

### 风险 1：hook 契约变化

缓解：

- 在实现里只依赖 V1 必需字段
- 升级 OpenClaw 时先跑 smoke test

### 风险 2：tool hook 影响主流程

缓解：

- 保持 `before_tool_call` 极轻量
- 全部 try/catch

### 风险 3：trace 体积过大

缓解：

- Root Run 不上传完整 `messages`
- V1 不追求全量 transcript

### 风险 4：LangSmith 不可用

缓解：

- fail-open
- 本地状态照常清理

## 18. 伪代码骨架

```ts
register(api) {
  const config = parseConfig(api.pluginConfig);
  const client = createLangSmithClient(config);
  const tracer = createTracer({ client, logger: api.logger, config });

  api.on("llm_input", async (event, ctx) => {
    try {
      tracer.startLlmRun({ event, ctx });
    } catch (err) {
      api.logger.warn(`llm_input trace failed: ${String(err)}`);
    }
  });

  api.on("llm_output", async (event, ctx) => {
    try {
      tracer.finishLlmRun({ event, ctx });
    } catch (err) {
      api.logger.warn(`llm_output trace failed: ${String(err)}`);
    }
  });

  api.on("before_tool_call", async (event, ctx) => {
    try {
      tracer.startToolRun({ event, ctx });
    } catch (err) {
      api.logger.warn(`before_tool_call trace failed: ${String(err)}`);
    }
  });

  api.on("after_tool_call", async (event, ctx) => {
    try {
      tracer.finishToolRun({ event, ctx });
    } catch (err) {
      api.logger.warn(`after_tool_call trace failed: ${String(err)}`);
    }
  });

  api.on("agent_end", async (event, ctx) => {
    try {
      tracer.finishRootRun({ event, ctx });
    } catch (err) {
      api.logger.warn(`agent_end trace failed: ${String(err)}`);
    }
  });
}
```

## 19. 实现完成的定义

实现完成，不是“代码写完”，而是以下条件同时满足：

- 插件仓库能独立构建
- 本地可通过链接方式安装到 OpenClaw
- 普通问答可在 LangSmith 中生成 Root + LLM trace
- 工具调用可在 LangSmith 中生成 Tool Child Run
- `agent_end` 能正确结束 Root Run
- 关键单元测试存在且通过
- 插件失败不影响 OpenClaw 主流程
