"""
types.py -- types.ts 的 Python 对照翻译

全局概述:
本模块定义了 tracer 内部使用的 TypeScript 契约(contracts).
它故意比完整的 OpenClaw 运行时 API 更窄, 这样后续阶段可以把
(event, ctx) 映射到一个小而可测试的追踪接口上.

======== TypeScript vs Python 语法对照笔记 ========

1. 交叉类型(Intersection Type):
   TS: type StartLlmRunParams = OpenClawTraceContext & { provider: string; ... }
   -- & 表示"把两个类型合并成一个", 新类型同时拥有两边的所有字段
   PY: 用类继承实现, class StartLlmRunParams(OpenClawTraceContext): ...

2. Pick 工具类型:
   TS: Pick<ResolvedLangSmithPluginConfig, "projectName" | "debug">
   -- 从一个类型中只挑选指定的字段, 构成新类型
   PY: 没有直接等价物, 通常定义一个新的小 dataclass 或用 TypedDict

3. Record<string, unknown>:
   TS: Record<string, unknown>  -- 键是字符串、值是任意类型的对象
   PY: dict[str, Any]

4. unknown[] vs Any[]:
   TS: unknown[]  -- 元素类型未知的数组, 比 any[] 更安全
   PY: list[Any]  -- Python 没有 unknown 的概念, 用 Any 代替

5. 函数类型签名:
   TS: createRunTree: (params: Record<string, unknown>) => LangSmithRunTreeLike
   -- 这是一个"函数类型", 描述了函数的参数和返回值
   PY: Callable[[dict[str, Any]], LangSmithRunTreeLike]
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, TYPE_CHECKING

if TYPE_CHECKING:
    # 避免循环导入, 只在类型检查时导入
    # TS 中用 "import type" 达到同样效果
    pass


# --------------------------------------------------------------------------- #
#  共享上下文 (对应 TS 的 OpenClawTraceContext)
# --------------------------------------------------------------------------- #

# TS 原文:
#   export type OpenClawTraceContext = {
#     openclawRunId: string;
#     sessionId?: string;
#     sessionKey?: string;
#     ...
#   };


@dataclass
class OpenClawTraceContext:
    """跨 root/llm/tool/agent-end 操作共享的追踪上下文.

    每次 OpenClaw 触发 hook 时, 都会携带这些上下文信息,
    让我们知道"这次追踪属于哪个会话、哪个 agent、哪次运行".
    """
    openclaw_run_id: str = ""
    session_id: str | None = None
    session_key: str | None = None
    agent_id: str | None = None
    workspace_dir: str | None = None
    message_provider: str | None = None
    trigger: str | None = None
    channel_id: str | None = None


# TS 原文:
#   export type OpenClawAgentHookContext = { ... };


@dataclass
class OpenClawAgentHookContext:
    """OpenClaw agent hook 提供的最小上下文快照."""
    run_id: str | None = None
    agent_id: str | None = None
    session_key: str | None = None
    session_id: str | None = None
    workspace_dir: str | None = None
    message_provider: str | None = None
    trigger: str | None = None
    channel_id: str | None = None


# --------------------------------------------------------------------------- #
#  事件类型 (对应 TS 的 OpenClawLlmInputEvent / OpenClawLlmOutputEvent)
# --------------------------------------------------------------------------- #

# TS 原文:
#   export type OpenClawLlmInputEvent = {
#     runId: string;
#     sessionId: string;
#     provider: string;
#     model: string;
#     systemPrompt?: string;
#     prompt: string;
#     historyMessages: unknown[];
#     imagesCount: number;
#   };


@dataclass
class OpenClawLlmInputEvent:
    """llm_input hook 的事件载荷(payload).

    当 OpenClaw 即将调用 LLM 时触发, 包含发送给 LLM 的所有输入信息.
    """
    run_id: str = ""
    session_id: str = ""
    provider: str = ""           # 例如 "anthropic", "openai"
    model: str = ""              # 例如 "claude-sonnet-4-6"
    prompt: str = ""             # 用户的提示词
    history_messages: list[Any] = field(default_factory=list)  # 历史对话
    images_count: int = 0        # 附带的图片数量
    system_prompt: str | None = None  # 系统提示词(可选)


@dataclass
class OpenClawLlmOutputEvent:
    """llm_output hook 的事件载荷.

    当 LLM 返回结果时触发, 包含 LLM 的输出和 token 用量.
    """
    run_id: str = ""
    session_id: str = ""
    provider: str = ""
    model: str = ""
    assistant_texts: list[str] = field(default_factory=list)  # 助手回复文本
    last_assistant: Any = None   # 最后一条助手消息的完整对象
    usage: dict[str, Any] | None = None  # token 用量统计
    # TS 中 usage 的结构:
    # { input?: number; output?: number; cacheRead?: number;
    #   cacheWrite?: number; total?: number; }


# --------------------------------------------------------------------------- #
#  Tracer 参数类型 (对应 TS 的交叉类型 & )
# --------------------------------------------------------------------------- #

# TS 原文:
#   export type StartLlmRunParams = OpenClawTraceContext & {
#     provider: string;
#     model: string;
#     ...
#   };
#
# 语法对照:
#   TS 的 & (交叉类型) 把两个类型的字段合并成一个新类型
#   Python 用类继承来实现: 子类自动拥有父类的所有字段


@dataclass
class StartLlmRunParams(OpenClawTraceContext):
    """启动 LLM 子运行所需的参数.

    继承了 OpenClawTraceContext 的所有字段(run_id, session_id 等),
    再加上 LLM 特有的字段(provider, model 等).
    这就是 TS 中 & 交叉类型的 Python 等价写法.
    """
    provider: str = ""
    model: str = ""
    prompt: str = ""
    history_messages: list[Any] = field(default_factory=list)
    images_count: int = 0
    system_prompt: str | None = None


@dataclass
class FinishLlmRunParams(OpenClawTraceContext):
    """结束 LLM 子运行所需的参数."""
    provider: str = ""
    model: str = ""
    assistant_texts: list[str] = field(default_factory=list)
    last_assistant: Any = None
    usage: dict[str, Any] | None = None


@dataclass
class StartToolRunParams(OpenClawTraceContext):
    """启动工具子运行所需的参数."""
    tool_name: str = ""
    params: dict[str, Any] = field(default_factory=dict)
    tool_call_id: str | None = None


@dataclass
class FinishToolRunParams(OpenClawTraceContext):
    """结束工具子运行所需的参数."""
    tool_name: str = ""
    tool_call_id: str | None = None
    result: Any = None
    error: str | None = None
    duration_ms: float | None = None


@dataclass
class FinishRootRunParams(OpenClawTraceContext):
    """结束根运行(一个完整的 agent turn)所需的参数."""
    messages: list[Any] = field(default_factory=list)
    success: bool = True
    error: str | None = None
    duration_ms: float | None = None


# --------------------------------------------------------------------------- #
#  依赖注入类型 (对应 TS 的 LangSmithTracerDependencies)
# --------------------------------------------------------------------------- #

# TS 原文:
#   export type LangSmithTracerDependencies = {
#     config: Pick<ResolvedLangSmithPluginConfig, "projectName" | "debug">;
#     logger: PluginLogger;
#     createRunTree: (params: Record<string, unknown>) => LangSmithRunTreeLike;
#   };
#
# 语法对照:
#   Pick<Type, Keys>  -- TS 的工具类型, 从 Type 中只挑选指定的 Keys
#   -- Pick<ResolvedLangSmithPluginConfig, "projectName" | "debug">
#   -- 意思是: 只需要 projectName 和 debug 两个字段, 其他不关心
#   Python 没有 Pick, 直接定义一个小 dataclass 即可


@dataclass
class TracerConfigSlice:
    """tracer 需要的配置子集.

    对应 TS 的 Pick<ResolvedLangSmithPluginConfig, "projectName" | "debug">.
    不需要完整配置, 只取 tracer 关心的两个字段.
    """
    project_name: str = "openclaw"
    debug: bool = False


@dataclass
class LangSmithTracerDependencies:
    """注入到 tracer 的运行时依赖.

    这是"依赖注入"模式: tracer 不自己创建这些对象,
    而是由外部(index.py)创建好后传进来.
    好处是方便测试 -- 测试时可以传入 mock 对象.
    """
    config: TracerConfigSlice | None = None
    logger: Any = None           # PluginLogger 接口
    create_run_tree: Any = None  # 工厂函数


# --------------------------------------------------------------------------- #
#  状态快照 (对应 TS 的 LangSmithTracerStateSnapshot)
# --------------------------------------------------------------------------- #

@dataclass
class LangSmithTracerStateSnapshot:
    """tracer 内部状态的轻量快照, 用于调试和测试."""
    root_run_count: int = 0
    llm_run_count: int = 0
    llm_sequence_owners: list[str] = field(default_factory=list)
    active_llm_owners: list[dict[str, Any]] = field(default_factory=list)
    tool_run_count: int = 0
    tool_sequence_owners: list[str] = field(default_factory=list)
    active_tool_buckets: list[dict[str, Any]] = field(default_factory=list)


# --------------------------------------------------------------------------- #
#  Tracer 公共接口 (对应 TS 的 LangSmithTracer type)
# --------------------------------------------------------------------------- #

# TS 原文:
#   export type LangSmithTracer = {
#     ensureRootRun: (params: OpenClawTraceContext) => Promise<... | undefined>;
#     startLlmRun: (params: StartLlmRunParams) => Promise<void>;
#     ...
#   };
#
# 语法对照:
#   TS 用 type 定义一个"对象类型", 里面的每个字段都是函数签名
#   Python 用 Protocol 定义同样的"鸭子类型接口"


class LangSmithTracer(Protocol):
    """tracer 的公共接口, hook handler 通过这个接口调用 tracer."""

    async def ensure_root_run(self, params: OpenClawTraceContext) -> Any: ...
    async def start_llm_run(self, params: StartLlmRunParams) -> None: ...
    async def finish_llm_run(self, params: FinishLlmRunParams) -> None: ...
    async def start_tool_run(self, params: StartToolRunParams) -> None: ...
    async def finish_tool_run(self, params: FinishToolRunParams) -> None: ...
    async def finish_root_run(self, params: FinishRootRunParams) -> None: ...
    def get_state_snapshot(self) -> LangSmithTracerStateSnapshot: ...


# TS 原文:
#   export type GetLangSmithTracer = () => Promise<LangSmithTracer | undefined>;
#
# 语法对照:
#   这是一个"函数类型别名": 一个无参数的异步函数, 返回 tracer 或 undefined
#   Python 用 Callable 或直接写类型注解

# GetLangSmithTracer 在 Python 中就是:
#   async def get_tracer() -> LangSmithTracer | None
# 不需要单独定义类型别名, 直接在函数签名中写即可
