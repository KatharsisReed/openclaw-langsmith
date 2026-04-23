"""
index.py -- index.ts 的 Python 对照翻译

全局概述:
这是 OpenClaw 加载插件时的入口文件.
Phase 4 的入口现在会:
- 暴露真正的配置结构(config schema)
- 以"宽容失败"(fail-open)的方式初始化 LangSmith 运行时
- 注册最小的 LLM 追踪循环(llm_input / llm_output)

======== TypeScript vs Python 语法对照笔记 ========

1. 模块默认导出:
   TS: export default definePluginEntry({...})
   -- 一个模块只能有一个 default export, 导入时不需要大括号
   PY: Python 没有 default export 的概念, 通常在模块底部定义主对象

2. void 返回类型:
   TS: function xxx(): void  -- 表示函数不返回任何值
   PY: def xxx() -> None:    -- 等价写法

3. Promise 链 + 懒加载:
   TS: const tracerPromise = createTracerPromise(logger, parsed);
       getTracer: () => tracerPromise
   -- tracerPromise 是一个 Promise, 多次调用 getTracer 返回同一个 Promise
   -- 这是"懒加载"模式: hook 注册时 tracer 可能还没初始化完, 但 hook 被触发时会 await 它
   PY: 用 asyncio.Task 或缓存的 coroutine 实现同样效果

4. 事件注册:
   TS: api.on("llm_input", llmHandlers.onLlmInput);
   -- 典型的事件监听器模式(EventEmitter pattern)
   PY: api.on("llm_input", llm_handlers.on_llm_input)  -- 完全一样的模式

5. 接口/类型导入:
   TS: import { type PluginLogger } from "openclaw/..."
   -- "type" 关键字表示只导入类型信息, 编译后会被删除
   PY: Python 的类型注解本来就不影响运行时
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from config import (
    parse_langsmith_plugin_config,
    LangSmithPluginConfigParseResult,
)
from langsmith import (
    create_langsmith_runtime,
    describe_runtime_result,
    LangSmithRuntimeResult,
)
# Phase 4 新增的导入
from handlers.llm import create_llm_hook_handlers, LlmHookHandlerDependencies
from tracer import create_tracer


# --------------------------------------------------------------------------- #
#  常量
# --------------------------------------------------------------------------- #

PLUGIN_ID = "openclaw-langsmith"
PLUGIN_NAME = "OpenClaw LangSmith Tracing Plugin"
PLUGIN_DESCRIPTION = "LangSmith tracing plugin for OpenClaw agent execution."


# --------------------------------------------------------------------------- #
#  模拟 OpenClaw 框架类型 (正式代码中从框架导入)
# --------------------------------------------------------------------------- #

class PluginLogger:
    """模拟 OpenClaw 提供的插件日志接口."""

    def __init__(self):
        self._logger = logging.getLogger(PLUGIN_ID)

    def debug(self, message: str) -> None:
        self._logger.debug(message)

    def info(self, message: str) -> None:
        self._logger.info(message)

    def warn(self, message: str) -> None:
        self._logger.warning(message)

    def error(self, message: str) -> None:
        self._logger.error(message)


class OpenClawPluginApi:
    """模拟 OpenClaw 提供给插件的 API 接口.

    Phase 4 新增了 on() 方法, 用于注册事件监听器.
    """

    def __init__(self, plugin_config: Any = None):
        self.logger = PluginLogger()
        self.plugin_config = plugin_config
        self._handlers: dict[str, list] = {}  # 事件 -> handler 列表

    def on(self, event: str, handler) -> None:
        """注册事件监听器.

        TS: api.on("llm_input", llmHandlers.onLlmInput);
        这是 Node.js EventEmitter 模式的标准写法.

        Args:
            event: 事件名称, 如 "llm_input", "llm_output".
            handler: 事件触发时调用的回调函数.
        """
        self._handlers.setdefault(event, []).append(handler)


# --------------------------------------------------------------------------- #
#  日志工具
# --------------------------------------------------------------------------- #

class PrefixedLogger:
    """给所有日志消息加上统一的 [插件ID] 前缀."""

    def __init__(self, logger: PluginLogger):
        self._logger = logger

    def debug(self, message: str) -> None:
        if hasattr(self._logger, "debug") and self._logger.debug:
            self._logger.debug(f"[{PLUGIN_ID}] {message}")

    def info(self, message: str) -> None:
        self._logger.info(f"[{PLUGIN_ID}] {message}")

    def warn(self, message: str) -> None:
        self._logger.warn(f"[{PLUGIN_ID}] {message}")

    def error(self, message: str) -> None:
        self._logger.error(f"[{PLUGIN_ID}] {message}")


# --------------------------------------------------------------------------- #
#  启动日志逻辑 (和 Phase 2 相同)
# --------------------------------------------------------------------------- #

def log_config_issues(logger: PrefixedLogger, parsed: LangSmithPluginConfigParseResult) -> None:
    """记录配置验证问题, 但不阻止插件启动."""
    if len(parsed.issues) == 0:
        return
    logger.warn(
        f"Plugin config had validation issues. Falling back to defaults: "
        f"{'; '.join(parsed.issues)}"
    )


def log_runtime_result(
    logger: PrefixedLogger,
    parsed: LangSmithPluginConfigParseResult,
    result: LangSmithRuntimeResult,
) -> None:
    """根据初始化结果, 用合适的日志级别输出信息."""
    summary = describe_runtime_result(result)

    if result.status == "ready":
        if parsed.config.debug:
            logger.info(summary)
        return

    if result.reason == "plugin_disabled":
        logger.debug(summary)
        return

    if result.reason == "missing_api_key":
        if parsed.config.debug:
            logger.info(summary)
            return
        logger.debug(summary)
        return

    logger.warn(summary)


# --------------------------------------------------------------------------- #
#  Phase 4 新增: 懒加载 Tracer Promise
# --------------------------------------------------------------------------- #

# TS 原文:
#   function createTracerPromise(
#     logger: PluginLogger,
#     parsed: LangSmithPluginConfigParseResult,
#   ): Promise<LangSmithTracer | undefined> {
#     return createLangSmithRuntime(parsed.config)
#       .then((result) => {
#         let tracer: LangSmithTracer | undefined;
#         if (result.status === "ready") {
#           tracer = createTracer({ config: parsed.config, logger, createRunTree: result.createRunTree });
#         }
#         logLangSmithRuntimeResult(logger, parsed, result);
#         return tracer;
#       })
#       .catch((error: unknown) => {
#         logger.warn(`LangSmith runtime initialization failed: ${message}`);
#         return undefined;
#       });
#   }
#
# 语法对照:
#   这个函数返回一个 Promise<LangSmithTracer | undefined>
#   -- Promise 是 TS/JS 的异步原语, 代表"一个将来会有结果的值"
#   -- .then() 在 Promise 成功时执行, .catch() 在失败时执行
#   -- 整个链条本身也是一个 Promise, 可以被 await
#
#   关键设计: tracerPromise 只创建一次, 但可以被多个 hook handler 共享
#   -- 第一次 await 时会等待初始化完成
#   -- 后续 await 直接返回已缓存的结果(Promise 只 resolve 一次)
#   -- 这就是"懒加载"(lazy initialization)模式
#
#   Python 等价: asyncio.Task 也有同样的特性 -- await 多次返回同一个结果


async def _create_tracer_coroutine(
    logger: PrefixedLogger,
    parsed: LangSmithPluginConfigParseResult,
) -> Any:
    """异步初始化 tracer, 对应 TS 的 createTracerPromise.

    Args:
        logger: 带前缀的日志器.
        parsed: 解析后的配置.

    Returns:
        tracer 实例, 或 None.
    """
    try:
        # TS: .then((result) => { ... })
        result = await create_langsmith_runtime(parsed.config)
        tracer = None
        if result.status == "ready":
            tracer = create_tracer(
                config=parsed.config,
                logger=logger,
                create_run_tree=result.create_run_tree,
            )
        log_runtime_result(logger, parsed, result)
        return tracer
    except Exception as error:
        # TS: .catch((error: unknown) => { ... })
        message = str(error) if str(error) else "Unknown LangSmith initialization error"
        logger.warn(f"LangSmith runtime initialization failed: {message}")
        return None


# --------------------------------------------------------------------------- #
#  插件注册入口 (Phase 4 版本)
# --------------------------------------------------------------------------- #

# TS 原文:
#   function registerPlugin(api: OpenClawPluginApi): void {
#     const logger = createPrefixedLogger(api.logger);
#     const parsed = parseLangSmithPluginConfig(api.pluginConfig);
#     logConfigIssues(logger, parsed);
#
#     const tracerPromise = createTracerPromise(logger, parsed);
#     const llmHandlers = createLlmHookHandlers({
#       logger,
#       getTracer: () => tracerPromise,
#     });
#
#     api.on("llm_input", llmHandlers.onLlmInput);
#     api.on("llm_output", llmHandlers.onLlmOutput);
#   }
#
# Phase 4 的关键变化:
#   1. 不再是"发射后不管", 而是创建一个 tracerPromise 并传给 hook handler
#   2. hook handler 通过 getTracer 获取 tracer -- 如果还没初始化完就等待
#   3. 用 api.on() 注册了两个事件监听器: llm_input 和 llm_output
#
# 语法对照:
#   getTracer: () => tracerPromise
#   -- 这是一个箭头函数, 每次调用都返回同一个 tracerPromise
#   -- 因为 Promise 只 resolve 一次, 所以多次 await 得到同一个 tracer
#   Python: lambda: tracer_task  -- 或者用闭包函数


def register_plugin(api: OpenClawPluginApi) -> None:
    """注册插件到 OpenClaw.

    Phase 4 注册了最小的 LLM 追踪循环, 同时保持启动路径的 fail-open 特性.

    Args:
        api: OpenClaw 提供的插件 API.
    """
    logger = PrefixedLogger(api.logger)
    parsed = parse_langsmith_plugin_config(api.plugin_config)
    log_config_issues(logger, parsed)

    # 创建 tracer 的异步任务(懒加载)
    # TS: const tracerPromise = createTracerPromise(logger, parsed);
    # Python: 用 asyncio.ensure_future 把 coroutine 包装成 Task
    # Task 和 Promise 一样: 只执行一次, 多次 await 返回同一个结果
    try:
        loop = asyncio.get_running_loop()
        tracer_task = loop.create_task(_create_tracer_coroutine(logger, parsed))
    except RuntimeError:
        # 没有事件循环时的降级处理
        tracer_task = None

    # TS: const llmHandlers = createLlmHookHandlers({
    #       logger,
    #       getTracer: () => tracerPromise,
    #     });
    #
    # getTracer: () => tracerPromise 的含义:
    #   每次 hook 被触发时, handler 调用 getTracer() 获取 tracer
    #   getTracer 返回的是同一个 Promise/Task
    #   如果 tracer 还没初始化完, await 会等待; 如果已经完成, 直接返回结果

    async def get_tracer():
        """懒加载 tracer 的 getter 函数."""
        if tracer_task is None:
            return None
        return await tracer_task

    llm_handlers = create_llm_hook_handlers(LlmHookHandlerDependencies(
        logger=logger,
        get_tracer=get_tracer,
    ))

    # Phase 4 的核心: 注册事件监听器
    # TS: api.on("llm_input", llmHandlers.onLlmInput);
    #     api.on("llm_output", llmHandlers.onLlmOutput);
    #
    # 这就是"插件 hook"的本质:
    #   OpenClaw 在调用 LLM 之前触发 "llm_input" 事件
    #   OpenClaw 在 LLM 返回之后触发 "llm_output" 事件
    #   我们的 handler 在这两个时机记录追踪数据到 LangSmith
    api.on("llm_input", llm_handlers.on_llm_input)
    api.on("llm_output", llm_handlers.on_llm_output)


# 插件入口定义
plugin_entry = {
    "id": PLUGIN_ID,
    "name": PLUGIN_NAME,
    "description": PLUGIN_DESCRIPTION,
    "register": register_plugin,
}
