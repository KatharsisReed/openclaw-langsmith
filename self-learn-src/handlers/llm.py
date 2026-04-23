"""
handlers/llm.py -- handlers/llm.ts 的 Python 对照翻译

全局概述:
本模块把 OpenClaw 的 llm hook 翻译成 tracer 调用.
它故意保持很薄(thin):
- 规范化 event + ctx
- 等待懒加载的 tracer(如果可用)
- 保持 hook handler 的 fail-open 特性

======== TypeScript vs Python 语法对照笔记 ========

1. 展开运算符 + 函数调用:
   TS: await tracer.startLlmRun({ ...buildTraceContext(...), provider: event.provider, ... })
   -- { ...obj, key: value } 把 obj 的所有字段展开, 再加上新字段
   PY: await tracer.start_llm_run(StartLlmRunParams(**build_trace_context(...).__dict__, provider=...))
   -- 或者更常见的做法: 手动构造参数对象

2. 返回对象字面量中包含函数:
   TS: return { onLlmInput, onLlmOutput };
   -- 属性简写: { onLlmInput } 等价于 { onLlmInput: onLlmInput }
   PY: 用 class 或 namedtuple 返回, 或直接返回 dict

3. 工厂函数返回类型:
   TS: function createLlmHookHandlers(deps): {
         onLlmInput: (event, ctx) => Promise<void>;
         onLlmOutput: (event, ctx) => Promise<void>;
       }
   -- 返回类型是一个匿名对象类型, 包含两个函数字段
   PY: 用 class 或 dataclass 包装
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from types_module import (
    OpenClawTraceContext,
    OpenClawAgentHookContext,
    OpenClawLlmInputEvent,
    OpenClawLlmOutputEvent,
    StartLlmRunParams,
    FinishLlmRunParams,
)


# --------------------------------------------------------------------------- #
#  依赖类型
# --------------------------------------------------------------------------- #

# TS 原文:
#   export type LlmHookHandlerDependencies = {
#     getTracer: GetLangSmithTracer;
#     logger: PluginLogger;
#   };


@dataclass
class LlmHookHandlerDependencies:
    """注入到 LLM hook handler 工厂的依赖.

    - get_tracer: 异步函数, 返回 tracer 实例或 None
    - logger: 日志器
    """
    get_tracer: Any = None   # async () -> LangSmithTracer | None
    logger: Any = None       # PluginLogger


# --------------------------------------------------------------------------- #
#  上下文构建
# --------------------------------------------------------------------------- #

# TS 原文:
#   function buildTraceContext(
#     runId: string, sessionId: string, ctx: OpenClawAgentHookContext,
#   ): OpenClawTraceContext {
#     return { openclawRunId: runId, sessionId, sessionKey: ctx.sessionKey, ... };
#   }
#
# 语法对照:
#   { openclawRunId: runId, sessionId, ... }
#   -- sessionId 是属性简写: 当属性名和变量名相同时, 可以省略冒号后面的部分
#   -- 等价于 { sessionId: sessionId }
#   Python 没有这种简写, 必须写完整


def _build_trace_context(
    run_id: str,
    session_id: str,
    ctx: OpenClawAgentHookContext,
) -> OpenClawTraceContext:
    """把 hook 的载荷转换成共享的追踪上下文.

    Args:
        run_id: OpenClaw 运行 ID.
        session_id: 会话 ID.
        ctx: hook 上下文快照.

    Returns:
        统一的追踪上下文对象.
    """
    return OpenClawTraceContext(
        openclaw_run_id=run_id,
        session_id=session_id,
        session_key=ctx.session_key,
        agent_id=ctx.agent_id,
        workspace_dir=ctx.workspace_dir,
        message_provider=ctx.message_provider,
        trigger=ctx.trigger,
        channel_id=ctx.channel_id,
    )


# --------------------------------------------------------------------------- #
#  Hook Handler 返回类型
# --------------------------------------------------------------------------- #

@dataclass
class LlmHookHandlers:
    """LLM hook handler 对.

    对应 TS 中 createLlmHookHandlers 的返回类型:
    { onLlmInput: ..., onLlmOutput: ... }
    """
    on_llm_input: Any = None   # async (event, ctx) -> None
    on_llm_output: Any = None  # async (event, ctx) -> None


# --------------------------------------------------------------------------- #
#  工厂函数
# --------------------------------------------------------------------------- #

# TS 原文:
#   export function createLlmHookHandlers(deps: LlmHookHandlerDependencies): {
#     onLlmInput: (event, ctx) => Promise<void>;
#     onLlmOutput: (event, ctx) => Promise<void>;
#   } {
#     async function onLlmInput(event, ctx) { ... }
#     async function onLlmOutput(event, ctx) { ... }
#     return { onLlmInput, onLlmOutput };
#   }
#
# 这又是闭包工厂模式:
#   - createLlmHookHandlers 是工厂
#   - deps 被内部函数捕获(闭包)
#   - 返回包含两个函数的对象


def create_llm_hook_handlers(deps: LlmHookHandlerDependencies) -> LlmHookHandlers:
    """创建 Phase 4 的 LLM hook handler.

    Args:
        deps: handler 依赖.

    Returns:
        包含 on_llm_input 和 on_llm_output 两个回调的对象.
    """

    async def on_llm_input(
        event: OpenClawLlmInputEvent,
        ctx: OpenClawAgentHookContext,
    ) -> None:
        """处理 llm_input hook, 永远不向 OpenClaw 抛出异常.

        Args:
            event: llm_input 事件载荷.
            ctx: hook 上下文.
        """
        try:
            # TS: const tracer = await deps.getTracer();
            tracer = await deps.get_tracer()
            if not tracer:
                return

            # TS: await tracer.startLlmRun({
            #       ...buildTraceContext(event.runId, event.sessionId, ctx),
            #       provider: event.provider,
            #       ...
            #     });
            #
            # TS 的 { ...obj, key: value } 展开语法在这里的作用:
            # 把 buildTraceContext 返回的所有字段(openclawRunId, sessionId 等)
            # 和 LLM 特有的字段(provider, model 等)合并成一个对象
            #
            # Python 中我们直接构造 StartLlmRunParams, 手动传入所有字段
            trace_ctx = _build_trace_context(event.run_id, event.session_id, ctx)
            await tracer.start_llm_run(StartLlmRunParams(
                openclaw_run_id=trace_ctx.openclaw_run_id,
                session_id=trace_ctx.session_id,
                session_key=trace_ctx.session_key,
                agent_id=trace_ctx.agent_id,
                workspace_dir=trace_ctx.workspace_dir,
                message_provider=trace_ctx.message_provider,
                trigger=trace_ctx.trigger,
                channel_id=trace_ctx.channel_id,
                provider=event.provider,
                model=event.model,
                system_prompt=event.system_prompt,
                prompt=event.prompt,
                history_messages=event.history_messages,
                images_count=event.images_count,
            ))
        except Exception as error:
            # TS: const message = error instanceof Error ? error.message : String(error);
            deps.logger.warn(f"llm_input trace failed: {error}")

    async def on_llm_output(
        event: OpenClawLlmOutputEvent,
        ctx: OpenClawAgentHookContext,
    ) -> None:
        """处理 llm_output hook, 永远不向 OpenClaw 抛出异常.

        Args:
            event: llm_output 事件载荷.
            ctx: hook 上下文.
        """
        try:
            tracer = await deps.get_tracer()
            if not tracer:
                return

            trace_ctx = _build_trace_context(event.run_id, event.session_id, ctx)
            await tracer.finish_llm_run(FinishLlmRunParams(
                openclaw_run_id=trace_ctx.openclaw_run_id,
                session_id=trace_ctx.session_id,
                session_key=trace_ctx.session_key,
                agent_id=trace_ctx.agent_id,
                workspace_dir=trace_ctx.workspace_dir,
                message_provider=trace_ctx.message_provider,
                trigger=trace_ctx.trigger,
                channel_id=trace_ctx.channel_id,
                provider=event.provider,
                model=event.model,
                assistant_texts=event.assistant_texts,
                last_assistant=event.last_assistant,
                usage=event.usage,
            ))
        except Exception as error:
            deps.logger.warn(f"llm_output trace failed: {error}")

    return LlmHookHandlers(
        on_llm_input=on_llm_input,
        on_llm_output=on_llm_output,
    )
