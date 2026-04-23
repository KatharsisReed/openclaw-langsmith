"""
tracer.py -- tracer.ts 的 Python 对照翻译

全局概述:
本模块是 Phase 3 的追踪状态机(tracing state machine).
它不直接知道 OpenClaw 的 hook 注册机制, 而是接收已经规范化的追踪事件, 管理:
- root run 的创建
- llm/tool 子运行的生命周期
- 跨 hook 的状态索引
- 一轮结束后的清理

======== TypeScript vs Python 语法对照笔记 ========

1. 闭包(Closure) / 工厂模式:
   TS: export function createTracer(deps) { const map = new Map(); function xxx() {...} return { xxx }; }
   -- 整个 createTracer 是一个工厂函数, 内部的变量(map)被返回的函数们共享
   -- 这些内部函数"关闭"了外部变量, 形成闭包
   PY: 同样可以用闭包, 但 Python 更常用 class 来实现同样的状态封装

2. Map<K, V>:
   TS: new Map<string, RunTreeLike>()  -- 强类型的键值映射
   PY: dict[str, Any]                  -- Python 的 dict 就是 Map

3. Array.from() + .map() + .sort() + .filter():
   TS: Array.from(map.entries()).map(([k, v]) => ({...})).sort(...)
   PY: sorted([{...} for k, v in map.items()], key=...)

4. 解构赋值(Destructuring):
   TS: const [key, record] = entry      -- 从数组/元组中解构
   TS: const { openclawRunId } = params  -- 从对象中解构
   PY: key, record = entry               -- Python 的元组解包
   PY: openclaw_run_id = params.openclaw_run_id  -- 没有对象解构语法

5. Object.fromEntries / Object.entries:
   TS: Object.fromEntries(Object.entries(obj).filter(...))
   -- entries: 对象 -> [[key, value], ...] 数组
   -- fromEntries: [[key, value], ...] 数组 -> 对象
   PY: {k: v for k, v in obj.items() if ...}  -- 字典推导式, 更简洁
"""

from __future__ import annotations

from typing import Any

from types_module import (  # 注意: 实际项目中是 from types import ...
    OpenClawTraceContext,
    StartLlmRunParams,
    FinishLlmRunParams,
    StartToolRunParams,
    FinishToolRunParams,
    FinishRootRunParams,
    LangSmithTracerDependencies,
    LangSmithTracerStateSnapshot,
)


# --------------------------------------------------------------------------- #
#  内部记录类型 (对应 TS 的 type LlmRunRecord / ToolRunRecord)
# --------------------------------------------------------------------------- #

# TS 原文:
#   type LlmRunRecord = {
#     key: string;
#     openclawRunId: string;
#     sequence: number;
#     run: LangSmithRunTreeLike;
#   };
#
# 注意这里没有 export -- 这是模块内部的私有类型, 外部无法导入.
# Python 中用下划线前缀 _ 表示"私有", 但不是强制的.


class _LlmRunRecord:
    """一条 LLM 子运行的内存记录."""
    def __init__(self, key: str, openclaw_run_id: str, sequence: int, run: Any):
        self.key = key
        self.openclaw_run_id = openclaw_run_id
        self.sequence = sequence
        self.run = run


class _ToolRunRecord:
    """一条工具子运行的内存记录."""
    def __init__(
        self,
        canonical_key: str,
        fallback_key: str,
        openclaw_run_id: str,
        tool_name: str,
        run: Any,
        tool_call_id: str | None = None,
    ):
        self.canonical_key = canonical_key
        self.fallback_key = fallback_key
        self.openclaw_run_id = openclaw_run_id
        self.tool_name = tool_name
        self.tool_call_id = tool_call_id
        self.run = run


# --------------------------------------------------------------------------- #
#  工具函数
# --------------------------------------------------------------------------- #

# TS 原文:
#   function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
#     return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
#   }
#
# 语法对照:
#   Object.entries(value)  -- 把对象变成 [[key, value], ...] 数组
#   .filter(([, entry]) => ...)  -- 过滤, [, entry] 表示忽略第一个元素(key)
#   Object.fromEntries(...)  -- 把 [[key, value], ...] 数组变回对象
#   Python 等价: 字典推导式 {k: v for k, v in d.items() if v is not None}


def _compact_record(value: dict[str, Any]) -> dict[str, Any]:
    """去掉字典中值为 None 的键值对.

    发送到 LangSmith 之前清理数据, 避免传入无意义的 None 值.

    Args:
        value: 可能包含 None 值的字典.

    Returns:
        只包含非 None 值的新字典.
    """
    return {k: v for k, v in value.items() if v is not None}


def _build_base_metadata(params: OpenClawTraceContext) -> dict[str, Any]:
    """构建每个 run 都会携带的基础元数据.

    Args:
        params: OpenClaw 执行上下文.

    Returns:
        紧凑的元数据字典.
    """
    return _compact_record({
        "openclawRunId": params.openclaw_run_id,
        "sessionId": params.session_id,
        "sessionKey": params.session_key,
        "agentId": params.agent_id,
        "channelId": params.channel_id,
        "trigger": params.trigger,
    })


# TS 原文:
#   function mergeRunMetadata(run: LangSmithRunTreeLike, metadata: Record<string, unknown>): void {
#     run.metadata = { ...(run.metadata ?? {}), ...compactRecord(metadata) };
#   }
#
# 语法对照:
#   run.metadata ?? {}       -- 如果 run.metadata 是 null/undefined, 用空对象
#   { ...a, ...b }           -- 展开两个对象, 合并成一个新对象, b 覆盖 a 的同名键
#   Python: {**(a or {}), **compact(b)}


def _merge_run_metadata(run: Any, metadata: dict[str, Any]) -> None:
    """把新的元数据合并到已有的 run 上.

    Args:
        run: 可变的 RunTree 对象.
        metadata: 要合并的新字段.
    """
    existing = getattr(run, "metadata", None) or {}
    run.metadata = {**existing, **_compact_record(metadata)}


def _merge_run_outputs(run: Any, outputs: dict[str, Any]) -> None:
    """把新的输出数据合并到已有的 run 上.

    Args:
        run: 可变的 RunTree 对象.
        outputs: 要合并的输出字段.
    """
    existing = getattr(run, "outputs", None) or {}
    run.outputs = {**existing, **_compact_record(outputs)}


# --------------------------------------------------------------------------- #
#  键构建函数
# --------------------------------------------------------------------------- #

# TS 原文:
#   function buildLlmRunKey(openclawRunId: string, sequence: number): string {
#     return `${openclawRunId}:${sequence}`;
#   }
#
# 语法对照:
#   `${a}:${b}`  -- TS 模板字符串
#   f"{a}:{b}"   -- Python f-string, 完全等价


def _build_llm_run_key(openclaw_run_id: str, sequence: int) -> str:
    """构建 LLM 运行的内存索引键."""
    return f"{openclaw_run_id}:{sequence}"


def _build_tool_fallback_key(openclaw_run_id: str, tool_name: str, sequence: int) -> str:
    """构建工具运行的备用索引键(当没有 toolCallId 时使用)."""
    return f"{openclaw_run_id}:{tool_name}:{sequence}"


def _build_active_tool_bucket_key(openclaw_run_id: str, tool_name: str) -> str:
    """构建活跃工具调用的分桶键."""
    return f"{openclaw_run_id}:{tool_name}"


# --------------------------------------------------------------------------- #
#  栈操作 (对应 TS 的 pushStackValue / popStackValue / removeStackValue)
# --------------------------------------------------------------------------- #

# TS 用 Map<string, string[]> 实现了一个"按键分组的栈"
# Python 用 dict[str, list[str]] 实现同样的数据结构


def _push_stack_value(stack_map: dict[str, list[str]], key: str, value: str) -> None:
    """往栈顶压入一个值.

    Args:
        stack_map: 按键分组的栈字典.
        key: 栈的拥有者键.
        value: 要压入的值.
    """
    # TS: const current = map.get(key) ?? [];
    # Python: dict.setdefault(key, []) -- 如果 key 不存在就创建空列表
    stack_map.setdefault(key, []).append(value)


def _pop_stack_value(stack_map: dict[str, list[str]], key: str) -> str | None:
    """从栈顶弹出最新的值.

    Args:
        stack_map: 按键分组的栈字典.
        key: 栈的拥有者键.

    Returns:
        栈顶的值, 如果栈为空则返回 None.
    """
    current = stack_map.get(key)
    if not current:
        return None
    # TS: current.pop()  -- 弹出并返回最后一个元素
    # Python: list.pop() -- 完全一样
    value = current.pop()
    if not current:
        del stack_map[key]    # TS: map.delete(key)
    return value


def _remove_stack_value(stack_map: dict[str, list[str]], key: str, value: str) -> None:
    """从栈中移除一个特定的值(不一定是栈顶).

    Args:
        stack_map: 按键分组的栈字典.
        key: 栈的拥有者键.
        value: 要移除的值.
    """
    current = stack_map.get(key)
    if not current:
        return
    # TS: current.filter((entry) => entry !== value)
    # Python: 列表推导式过滤
    remaining = [entry for entry in current if entry != value]
    if not remaining:
        del stack_map[key]
    else:
        stack_map[key] = remaining


# --------------------------------------------------------------------------- #
#  安全执行包装 (对应 TS 的 runSafely)
# --------------------------------------------------------------------------- #

# TS 原文:
#   async function runSafely(
#     logger, label,
#     fn: () => Promise<void>,
#   ): Promise<boolean> {
#     try { await fn(); return true; }
#     catch (error) { logger.warn(`${label}: ${message}`); return false; }
#   }
#
# 语法对照:
#   fn: () => Promise<void>  -- 参数是一个异步函数(无参数, 无返回值)
#   Python: fn: Callable[[], Awaitable[None]]  -- 或简单写 Any


async def _run_safely(logger: Any, label: str, fn) -> bool:
    """安全地执行异步操作, 失败时记录警告而非抛异常.

    这是"fail-open"(宽容失败)模式的核心:
    追踪失败不应该影响 OpenClaw 的正常运行.

    Args:
        logger: 日志器.
        label: 人类可读的操作描述.
        fn: 要执行的异步函数.

    Returns:
        True 表示成功, False 表示失败.
    """
    try:
        await fn()
        return True
    except Exception as error:
        logger.warn(f"{label}: {error}")
        return False


# --------------------------------------------------------------------------- #
#  核心: 创建 Tracer (对应 TS 的 export function createTracer)
# --------------------------------------------------------------------------- #

# TS 原文:
#   export function createTracer(deps: LangSmithTracerDependencies): LangSmithTracer {
#     const rootRuns = new Map<string, LangSmithRunTreeLike>();
#     ...
#     function ensureRootRun(...) { ... }
#     function startLlmRun(...) { ... }
#     ...
#     return { ensureRootRun, startLlmRun, ... };
#   }
#
# 语法对照:
#   这是 TS 中非常典型的"闭包工厂"模式:
#   - createTracer 是工厂函数
#   - 内部的 Map 变量是状态(相当于类的实例变量)
#   - 内部的 function 是方法(相当于类的方法)
#   - return { ... } 把方法暴露出去(相当于类的公共接口)
#
#   Python 翻译: 用 class 替代闭包, 更符合 Python 的习惯
#   - __init__ 对应 createTracer 的开头(初始化状态)
#   - 类方法对应内部 function
#   - 实例本身就是返回值


class Tracer:
    """Phase 3 追踪状态机.

    对应 TS 的 createTracer() 工厂函数.
    TS 用闭包封装状态, Python 用 class 封装状态 -- 效果完全一样.
    """

    def __init__(self, deps: LangSmithTracerDependencies):
        """初始化 tracer.

        对应 TS createTracer 函数体开头的那些 new Map() 初始化语句.

        Args:
            deps: 运行时依赖(配置、日志器、RunTree 工厂).
        """
        self._deps = deps

        # --- 状态存储 ---
        # TS: const rootRuns = new Map<string, LangSmithRunTreeLike>();
        # Python: dict 就是 Map
        self._root_runs: dict[str, Any] = {}
        self._llm_run_records: dict[str, _LlmRunRecord] = {}
        self._llm_sequence_by_run: dict[str, int] = {}
        self._active_llm_run_keys_by_run: dict[str, list[str]] = {}
        self._tool_run_records: dict[str, _ToolRunRecord] = {}
        self._tool_sequence_by_run: dict[str, int] = {}
        self._tool_fallback_to_canonical: dict[str, str] = {}
        self._active_tool_fallback_keys_by_bucket: dict[str, list[str]] = {}

    # ------------------------------------------------------------------- #
    #  Root Run
    # ------------------------------------------------------------------- #

    async def ensure_root_run(self, params: OpenClawTraceContext) -> Any | None:
        """确保当前 agent turn 有一个 root run 存在.

        如果已经存在, 更新元数据后返回; 如果不存在, 创建新的.

        Args:
            params: OpenClaw 运行上下文.

        Returns:
            root run 对象, 或创建失败时返回 None.
        """
        # TS: const existing = rootRuns.get(params.openclawRunId);
        existing = self._root_runs.get(params.openclaw_run_id)
        if existing:
            _merge_run_metadata(existing, _build_base_metadata(params))
            return existing

        # TS: let rootRun: LangSmithRunTreeLike;
        # TS 的 let vs const:
        #   let 表示变量可以被重新赋值
        #   const 表示变量绑定后不可改变
        #   这里用 let 是因为 rootRun 在 try 块内赋值, 在 try 块外使用
        try:
            root_run = self._deps.create_run_tree({
                "name": "openclaw.agent_turn",
                "run_type": "chain",
                "project_name": self._deps.config.project_name,
                "inputs": {},
                "metadata": _build_base_metadata(params),
                "tags": ["openclaw", "agent-turn"],
            })
        except Exception as error:
            self._deps.logger.warn(f"failed to create root run: {error}")
            return None

        # TS: rootRuns.set(params.openclawRunId, rootRun);
        # Python: dict[key] = value  (和 Map.set() 等价)
        self._root_runs[params.openclaw_run_id] = root_run
        await _run_safely(
            self._deps.logger,
            "failed to post root run",
            root_run.postRun,  # TS: async () => { await rootRun.postRun(); }
        )
        return root_run

    # ------------------------------------------------------------------- #
    #  LLM Run
    # ------------------------------------------------------------------- #

    async def start_llm_run(self, params: StartLlmRunParams) -> None:
        """启动一个 LLM 子运行, 并建立索引以便后续配对完成.

        Args:
            params: LLM 启动参数.
        """
        root_run = await self.ensure_root_run(params)
        if not root_run:
            return

        # TS: const nextSequence = (llmSequenceByRun.get(params.openclawRunId) ?? 0) + 1;
        # ?? 0 表示: 如果没找到就用 0
        next_sequence = self._llm_sequence_by_run.get(params.openclaw_run_id, 0) + 1
        self._llm_sequence_by_run[params.openclaw_run_id] = next_sequence
        llm_key = _build_llm_run_key(params.openclaw_run_id, next_sequence)

        try:
            llm_run = root_run.createChild({
                "name": "openclaw.llm",
                "run_type": "llm",
                "inputs": _compact_record({
                    "prompt": params.prompt,
                    "systemPrompt": params.system_prompt,
                    "historyMessages": params.history_messages,
                    "imagesCount": params.images_count,
                }),
                "metadata": {
                    **_build_base_metadata(params),
                    "provider": params.provider,
                    "model": params.model,
                    "llmSequence": next_sequence,
                },
                "tags": [
                    "openclaw", "llm",
                    f"provider:{params.provider}",
                    f"model:{params.model}",
                ],
            })
        except Exception as error:
            self._deps.logger.warn(f"failed to create llm child run: {error}")
            return

        self._llm_run_records[llm_key] = _LlmRunRecord(
            key=llm_key,
            openclaw_run_id=params.openclaw_run_id,
            sequence=next_sequence,
            run=llm_run,
        )
        _push_stack_value(self._active_llm_run_keys_by_run, params.openclaw_run_id, llm_key)

        await _run_safely(
            self._deps.logger,
            "failed to post llm child run",
            llm_run.postRun,
        )

    async def finish_llm_run(self, params: FinishLlmRunParams) -> None:
        """结束当前 turn 中最近的活跃 LLM 子运行.

        Args:
            params: LLM 完成参数.
        """
        llm_key = _pop_stack_value(self._active_llm_run_keys_by_run, params.openclaw_run_id)
        if not llm_key:
            self._deps.logger.warn(
                f"finishLlmRun could not find an active llm run for {params.openclaw_run_id}."
            )
            return

        record = self._llm_run_records.get(llm_key)
        if not record:
            self._deps.logger.warn(
                f"finishLlmRun lost llm record {llm_key} for {params.openclaw_run_id}."
            )
            return

        _merge_run_outputs(record.run, {
            "assistantTexts": params.assistant_texts,
            "lastAssistant": params.last_assistant,
        })
        _merge_run_metadata(record.run, {
            "provider": params.provider,
            "model": params.model,
            "usage": params.usage,
        })

        await _run_safely(self._deps.logger, "failed to end llm child run", record.run.end)
        await _run_safely(self._deps.logger, "failed to patch llm child run", record.run.patchRun)

        # TS: llmRunRecords.delete(llmKey);
        # Python: del dict[key]
        del self._llm_run_records[llm_key]

    # ------------------------------------------------------------------- #
    #  Tool Run
    # ------------------------------------------------------------------- #

    async def start_tool_run(self, params: StartToolRunParams) -> None:
        """启动一个工具子运行, 并建立多重索引(canonical + fallback).

        Args:
            params: 工具启动参数.
        """
        root_run = await self.ensure_root_run(params)
        if not root_run:
            return

        next_sequence = self._tool_sequence_by_run.get(params.openclaw_run_id, 0) + 1
        self._tool_sequence_by_run[params.openclaw_run_id] = next_sequence
        fallback_key = _build_tool_fallback_key(
            params.openclaw_run_id, params.tool_name, next_sequence
        )
        # TS: const canonicalKey = params.toolCallId ?? fallbackKey;
        canonical_key = params.tool_call_id if params.tool_call_id else fallback_key

        try:
            tool_run = root_run.createChild({
                "name": f"openclaw.tool.{params.tool_name}",
                "run_type": "tool",
                "inputs": {
                    "toolName": params.tool_name,
                    "params": params.params,
                },
                "metadata": {
                    **_build_base_metadata(params),
                    "toolCallId": params.tool_call_id,
                },
                "tags": ["openclaw", "tool", f"tool:{params.tool_name}"],
            })
        except Exception as error:
            self._deps.logger.warn(f"failed to create tool child run: {error}")
            return

        record = _ToolRunRecord(
            canonical_key=canonical_key,
            fallback_key=fallback_key,
            openclaw_run_id=params.openclaw_run_id,
            tool_name=params.tool_name,
            tool_call_id=params.tool_call_id,
            run=tool_run,
        )

        self._tool_run_records[canonical_key] = record
        self._tool_fallback_to_canonical[fallback_key] = canonical_key
        _push_stack_value(
            self._active_tool_fallback_keys_by_bucket,
            _build_active_tool_bucket_key(params.openclaw_run_id, params.tool_name),
            fallback_key,
        )

        await _run_safely(self._deps.logger, "failed to post tool child run", tool_run.postRun)

    def _resolve_tool_run_record(self, params: FinishToolRunParams) -> _ToolRunRecord | None:
        """通过 toolCallId 或 fallback 键查找工具运行记录.

        Args:
            params: 工具完成参数.

        Returns:
            匹配的记录, 或 None.
        """
        if params.tool_call_id:
            return self._tool_run_records.get(params.tool_call_id)

        fallback_key = _pop_stack_value(
            self._active_tool_fallback_keys_by_bucket,
            _build_active_tool_bucket_key(params.openclaw_run_id, params.tool_name),
        )
        if not fallback_key:
            return None

        canonical_key = self._tool_fallback_to_canonical.get(fallback_key, fallback_key)
        return self._tool_run_records.get(canonical_key)

    def _cleanup_finished_tool_run(self, record: _ToolRunRecord) -> None:
        """从所有索引中移除已完成的工具运行.

        Args:
            record: 已完成的工具运行记录.
        """
        self._tool_run_records.pop(record.canonical_key, None)
        self._tool_fallback_to_canonical.pop(record.fallback_key, None)
        _remove_stack_value(
            self._active_tool_fallback_keys_by_bucket,
            _build_active_tool_bucket_key(record.openclaw_run_id, record.tool_name),
            record.fallback_key,
        )

    async def finish_tool_run(self, params: FinishToolRunParams) -> None:
        """结束一个工具子运行, 清理所有相关索引.

        Args:
            params: 工具完成参数.
        """
        record = self._resolve_tool_run_record(params)
        if not record:
            self._deps.logger.warn(
                f"finishToolRun could not find a tool run for "
                f"{params.openclaw_run_id}:{params.tool_name}."
            )
            return

        _merge_run_outputs(record.run, {"result": params.result})
        _merge_run_metadata(record.run, {
            "toolCallId": record.tool_call_id,
            "durationMs": params.duration_ms,
        })
        if params.error:
            record.run.error = params.error

        await _run_safely(self._deps.logger, "failed to end tool child run", record.run.end)
        await _run_safely(self._deps.logger, "failed to patch tool child run", record.run.patchRun)
        self._cleanup_finished_tool_run(record)

    # ------------------------------------------------------------------- #
    #  Root Run 结束 + 清理
    # ------------------------------------------------------------------- #

    def _cleanup_run_state(self, openclaw_run_id: str) -> None:
        """清理一轮 agent turn 的所有内存状态.

        Args:
            openclaw_run_id: 要清理的运行 ID.
        """
        # TS: llmSequenceByRun.delete(openclawRunId);
        self._llm_sequence_by_run.pop(openclaw_run_id, None)
        self._active_llm_run_keys_by_run.pop(openclaw_run_id, None)

        # TS: for (const [key, record] of llmRunRecords.entries()) {
        #       if (record.openclawRunId === openclawRunId) { llmRunRecords.delete(key); }
        #     }
        # 注意: TS 中可以在遍历 Map 时 delete, Python 中不能在遍历 dict 时修改
        # 所以先收集要删除的 key, 再统一删除
        keys_to_delete = [
            k for k, rec in self._llm_run_records.items()
            if rec.openclaw_run_id == openclaw_run_id
        ]
        for k in keys_to_delete:
            del self._llm_run_records[k]

        self._tool_sequence_by_run.pop(openclaw_run_id, None)

        # TS: for (const bucketKey of Array.from(...keys())) {
        #       if (bucketKey.startsWith(`${openclawRunId}:`)) { ... }
        #     }
        # Array.from() 是因为 TS 中不能在遍历 Map 时删除, 先复制一份
        bucket_keys_to_delete = [
            k for k in self._active_tool_fallback_keys_by_bucket
            if k.startswith(f"{openclaw_run_id}:")
        ]
        for k in bucket_keys_to_delete:
            del self._active_tool_fallback_keys_by_bucket[k]

        fallback_keys_to_delete = [
            (fk, ck) for fk, ck in self._tool_fallback_to_canonical.items()
            if fk.startswith(f"{openclaw_run_id}:")
        ]
        for fk, ck in fallback_keys_to_delete:
            del self._tool_fallback_to_canonical[fk]
            self._tool_run_records.pop(ck, None)

    async def finish_root_run(self, params: FinishRootRunParams) -> None:
        """结束当前 agent turn 的根运行, 清理所有状态.

        Args:
            params: 根运行完成参数.
        """
        root_run = self._root_runs.get(params.openclaw_run_id)
        if not root_run:
            self._deps.logger.warn(
                f"finishRootRun could not find root run for {params.openclaw_run_id}."
            )
            self._cleanup_run_state(params.openclaw_run_id)
            return

        _merge_run_outputs(root_run, {
            "success": params.success,
            "error": params.error,
            "durationMs": params.duration_ms,
            # TS: messageCount: params.messages.length
            # .length 是 TS 数组的属性, len() 是 Python 的函数
            "messageCount": len(params.messages),
        })
        _merge_run_metadata(root_run, _build_base_metadata(params))
        if params.error:
            root_run.error = params.error

        await _run_safely(self._deps.logger, "failed to end root run", root_run.end)
        await _run_safely(self._deps.logger, "failed to patch root run", root_run.patchRun)

        # TS: rootRuns.delete(params.openclawRunId);
        del self._root_runs[params.openclaw_run_id]
        self._cleanup_run_state(params.openclaw_run_id)

    # ------------------------------------------------------------------- #
    #  状态快照
    # ------------------------------------------------------------------- #

    def get_state_snapshot(self) -> LangSmithTracerStateSnapshot:
        """返回当前内存状态的轻量快照, 用于调试和测试.

        TS 原文中大量使用了 Array.from().map().sort() 链式调用:
          Array.from(map.entries())   -- Map -> 数组
          .map(([k, v]) => ({...}))   -- 转换每个元素
          .sort((a, b) => a.localeCompare(b))  -- 排序

        Python 等价写法:
          sorted([{...} for k, v in d.items()], key=lambda x: x["field"])

        Returns:
            状态快照对象.
        """
        return LangSmithTracerStateSnapshot(
            root_run_count=len(self._root_runs),
            llm_run_count=len(self._llm_run_records),
            llm_sequence_owners=sorted(self._llm_sequence_by_run.keys()),
            active_llm_owners=sorted(
                [
                    {"openclawRunId": run_id, "activeCount": len(keys)}
                    for run_id, keys in self._active_llm_run_keys_by_run.items()
                ],
                key=lambda x: x["openclawRunId"],
            ),
            tool_run_count=len(self._tool_run_records),
            tool_sequence_owners=sorted(self._tool_sequence_by_run.keys()),
            active_tool_buckets=sorted(
                [
                    {"key": k, "activeCount": len(keys)}
                    for k, keys in self._active_tool_fallback_keys_by_bucket.items()
                ],
                key=lambda x: x["key"],
            ),
        )


# --------------------------------------------------------------------------- #
#  工厂函数 (对外暴露, 和 TS 的 export function createTracer 对应)
# --------------------------------------------------------------------------- #

def create_tracer(deps: LangSmithTracerDependencies) -> Tracer:
    """创建 Phase 3 追踪状态机.

    这是 TS 中 createTracer() 的 Python 等价物.
    TS 返回一个包含方法的闭包对象, Python 返回一个类实例 -- 效果一样.

    Args:
        deps: 运行时依赖.

    Returns:
        tracer 实例.
    """
    return Tracer(deps)
