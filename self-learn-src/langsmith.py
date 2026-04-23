"""
langsmith.py -- langsmith.ts 的 Python 对照翻译

全局概述:
本模块把 LangSmith SDK 的启动过程和插件的其他部分隔离开.
Phase 2 只需要一个清晰的初始化边界, 有四种明确的结果:
- disabled: 配置说不启用
- disabled: 缺少必要配置(API Key)
- unavailable: SDK 加载失败
- ready: 客户端就绪, 可以创建 RunTree

======== TypeScript vs Python 语法对照笔记 ========

1. 联合类型(Union Type / Discriminated Union):
   TS: type Result = { status: "disabled"; ... } | { status: "ready"; ... }
   PY: 用多个 dataclass + Literal 类型标注, 或用基类+子类

2. 动态导入:
   TS: await import("langsmith/client")  -- 运行时才加载模块
   PY: importlib.import_module("langsmith.client")

3. async/await:
   TS: async function xxx(): Promise<Result> { ... }
   PY: async def xxx() -> Result: ...
   两者语法几乎一样, 但底层机制不同(TS用事件循环+Promise, PY用asyncio)

4. try/catch vs try/except:
   TS: try { ... } catch (error) { ... }
   PY: try: ... except Exception as error: ...

5. 类型守卫(Type Guard):
   TS: function isRecord(value: unknown): value is Record<string, unknown>
   PY: 用 isinstance() 检查, 没有 "value is X" 这种特殊语法

6. 扩展运算符:
   TS: { ...params, client }  -- 把 params 的所有键值展开, 再加上 client
   PY: {**params, "client": client}  -- 字典解包, 语法类似
"""

from __future__ import annotations

import asyncio
import importlib
from dataclasses import dataclass
from typing import Any, Protocol


# 从同目录导入配置类型
# TS: import type { ResolvedLangSmithPluginConfig } from "./config.js";
# 注意 TS 的 "import type" 表示只导入类型, 不导入运行时代码
from config import ResolvedLangSmithPluginConfig


# --------------------------------------------------------------------------- #
#  类型定义 (对应 TS 的 type/interface)
# --------------------------------------------------------------------------- #

# TS 原文:
#   export type LangSmithClientLike = {
#     awaitPendingTraceBatches?: () => Promise<void>;
#   };
#
# 语法对照:
#   TS 的 type { methodName: () => ReturnType } 定义了一个"结构类型"(structural type)
#   -- 任何对象只要有这个方法就算符合这个类型, 不需要 extends 或 implements
#   Python 用 Protocol 实现类似的"鸭子类型"声明


class LangSmithClientLike(Protocol):
    """LangSmith 客户端的最小接口.

    TS 中用 type 定义一个"只要有这些方法就行"的类型.
    Python 用 Protocol 达到同样效果: 不需要继承, 只要有对应方法就符合.
    """

    async def await_pending_trace_batches(self) -> None:
        """等待所有待发送的追踪数据批次完成."""
        ...  # ... 在 Protocol 中表示"不需要实现", 类似 TS 的接口声明


class LangSmithRunTreeLike(Protocol):
    """RunTree 的最小接口.

    Phase 3/4 新增了多个可变字段(name, outputs, error, metadata, tags等),
    tracer.py 中的 mergeRunMetadata / mergeRunOutputs 会直接修改这些字段.

    TS 原文(Phase 4 版本):
      export type LangSmithRunTreeLike = {
        name?: string;
        run_type?: string;
        project_name?: string;
        inputs?: Record<string, unknown>;
        outputs?: Record<string, unknown>;
        error?: string;
        metadata?: Record<string, unknown>;
        tags?: string[];
        createChild: (params: Record<string, unknown>) => LangSmithRunTreeLike;
        postRun: () => Promise<void>;
        end: () => Promise<void>;
        patchRun: () => Promise<void>;
      };

    注意 TS 中的 ? 在这里的含义:
      对于字段(如 name?: string): 表示字段可选, 对象上可以没有这个属性
      对于方法: 如果方法名后面有 ?, 表示方法可选(但这里的方法都没有 ?)
    """

    # --- 可变字段(Phase 3/4 新增) ---
    name: str | None
    run_type: str | None
    project_name: str | None
    inputs: dict[str, Any] | None
    outputs: dict[str, Any] | None
    error: str | None
    metadata: dict[str, Any] | None
    tags: list[str] | None

    # --- 方法 ---
    def create_child(self, params: dict[str, Any]) -> LangSmithRunTreeLike: ...
    async def post_run(self) -> None: ...
    async def end(self) -> None: ...
    async def patch_run(self) -> None: ...


# --------------------------------------------------------------------------- #
#  运行时结果类型 (对应 TS 的联合类型 LangSmithRuntimeResult)
# --------------------------------------------------------------------------- #

# TS 原文:
#   export type LangSmithRuntimeResult =
#     | { status: "disabled"; reason: "plugin_disabled" | "missing_api_key"; ... }
#     | { status: "unavailable"; reason: "sdk_import_failed" | "sdk_shape_invalid"; ... }
#     | { status: "ready"; reason: "ready"; client: ...; createRunTree: ...; ... };
#
# 这是 TS 的"可辨识联合"(Discriminated Union):
#   通过 status 字段的字面量值来区分不同的分支.
#   比如 if (result.status === "ready") 之后, TS 编译器自动知道 result 有 client 字段.
#
# Python 翻译:
#   用多个 dataclass 子类, 通过 status 字段区分.
#   Python 3.10+ 可以用 match/case 语句实现类似的模式匹配.


@dataclass
class LangSmithRuntimeDisabled:
    """初始化结果: 功能被禁用(用户主动关闭或缺少 API Key)."""
    status: str = "disabled"                    # 固定值, 用于区分类型
    reason: str = ""                            # "plugin_disabled" 或 "missing_api_key"
    message: str = ""                           # 人类可读的说明
    config: ResolvedLangSmithPluginConfig | None = None


@dataclass
class LangSmithRuntimeUnavailable:
    """初始化结果: SDK 加载失败."""
    status: str = "unavailable"
    reason: str = ""                            # "sdk_import_failed" 或 "sdk_shape_invalid"
    message: str = ""
    config: ResolvedLangSmithPluginConfig | None = None
    error: Any = None                           # 原始异常, 用于调试


@dataclass
class LangSmithRuntimeReady:
    """初始化结果: 客户端就绪, 可以开始追踪."""
    status: str = "ready"
    reason: str = "ready"
    message: str = ""
    config: ResolvedLangSmithPluginConfig | None = None
    client: Any = None                          # LangSmith Client 实例
    create_run_tree: Any = None                 # 创建 RunTree 的工厂函数


# TS 的联合类型在 Python 中用 Union 表示
# TS: LangSmithRuntimeResult  (一个类型, 三种可能的形状)
# PY: LangSmithRuntimeResult  (三个类的联合)
LangSmithRuntimeResult = (
    LangSmithRuntimeDisabled | LangSmithRuntimeUnavailable | LangSmithRuntimeReady
)


# --------------------------------------------------------------------------- #
#  工具函数
# --------------------------------------------------------------------------- #

# TS 原文:
#   function isRecord(value: unknown): value is Record<string, unknown> {
#     return typeof value === "object" && value !== null;
#   }
#
# 语法对照:
#   "value is Record<string, unknown>" -- 这是 TS 的"类型谓词"(type predicate)
#   它告诉编译器: 如果这个函数返回 true, 那么 value 的类型就是 Record<string, unknown>
#   Python 没有等价语法, 直接用 isinstance 判断即可


def _is_dict_like(value: Any) -> bool:
    """检查值是否是类似字典的对象.

    Args:
        value: 任意值.

    Returns:
        True 表示是非 None 的字典/对象.
    """
    return isinstance(value, dict)


# --------------------------------------------------------------------------- #
#  结果构造器 (对应 TS 的 createDisabledResult / createUnavailableResult)
# --------------------------------------------------------------------------- #

# TS 原文:
#   function createDisabledResult(
#     config: ResolvedLangSmithPluginConfig,
#     reason: "plugin_disabled" | "missing_api_key",
#     message: string,
#   ): LangSmithRuntimeResult { ... }
#
# 语法对照:
#   reason: "plugin_disabled" | "missing_api_key"
#   -- TS 的字面量类型(Literal Type), 参数只能是这两个字符串之一
#   Python 中可以用 Literal["plugin_disabled", "missing_api_key"] 实现类似效果


def _create_disabled_result(
    config: ResolvedLangSmithPluginConfig,
    reason: str,
    message: str,
) -> LangSmithRuntimeDisabled:
    """构造一个"功能已禁用"的结果.

    Args:
        config: 规范化后的配置.
        reason: 机器可读的原因标识.
        message: 人类可读的说明.

    Returns:
        禁用状态的结果对象.
    """
    return LangSmithRuntimeDisabled(
        reason=reason,
        message=message,
        config=config,
    )


def _create_unavailable_result(
    config: ResolvedLangSmithPluginConfig,
    reason: str,
    message: str,
    error: Any = None,
) -> LangSmithRuntimeUnavailable:
    """构造一个"SDK 不可用"的结果.

    Args:
        config: 规范化后的配置.
        reason: 机器可读的失败原因.
        message: 人类可读的说明.
        error: 可选的原始异常.

    Returns:
        不可用状态的结果对象.
    """
    return LangSmithRuntimeUnavailable(
        reason=reason,
        message=message,
        config=config,
        error=error,
    )


# --------------------------------------------------------------------------- #
#  SDK 动态加载 (对应 TS 的 loadLangSmithSdk)
# --------------------------------------------------------------------------- #

# TS 原文:
#   async function loadLangSmithSdk(): Promise<{
#     Client: LangSmithClientConstructor;
#     RunTree: LangSmithRunTreeConstructor;
#   }> {
#     const [clientModule, runTreeModule] = await Promise.all([
#       import("langsmith/client"),
#       import("langsmith/run_trees"),
#     ]);
#     ...
#   }
#
# 语法对照:
#   import("langsmith/client")     -- TS 的动态导入, 返回 Promise
#   importlib.import_module(...)   -- Python 的动态导入, 同步执行
#
#   Promise.all([a, b])            -- TS 并发执行多个异步操作
#   asyncio.gather(a, b)           -- Python 的等价写法
#
#   const [a, b] = await xxx       -- TS 解构赋值(destructuring)
#   a, b = await xxx               -- Python 的解包赋值(unpacking)


def _load_langsmith_sdk() -> dict[str, Any]:
    """动态加载 LangSmith Python SDK.

    用动态导入而非顶部 import, 这样即使 SDK 没安装插件也不会崩溃.

    Returns:
        包含 Client 类和 RunTree 类的字典.

    Raises:
        ImportError: SDK 未安装.
        AttributeError: SDK 版本不对, 缺少预期的类.
    """
    # Python SDK 的包名是 "langsmith", 和 TS 的 "langsmith/client" 路径不同
    client_module = importlib.import_module("langsmith.client")
    run_tree_module = importlib.import_module("langsmith.run_trees")

    # TS: const Client = extractClientConstructor(clientModule);
    # TS 需要手动检查导出的形状, 因为动态导入返回的是 unknown
    # Python 直接用 getattr, 如果不存在会抛 AttributeError
    client_cls = getattr(client_module, "Client", None)
    run_tree_cls = getattr(run_tree_module, "RunTree", None)

    if client_cls is None or run_tree_cls is None:
        raise AttributeError(
            'LangSmith SDK is installed but does not expose the expected "Client" and "RunTree".'
        )

    return {"Client": client_cls, "RunTree": run_tree_cls}


# --------------------------------------------------------------------------- #
#  客户端创建
# --------------------------------------------------------------------------- #

# TS 原文:
#   function createClientInstance(
#     config: ResolvedLangSmithPluginConfig,
#     Client: LangSmithClientConstructor,
#   ): LangSmithClientLike {
#     return new Client({ apiKey: config.langsmithApiKey });
#   }
#
# 语法对照:
#   new Client({...})  -- TS 用 new 关键字实例化类
#   Client(...)        -- Python 直接调用类名即可, 不需要 new


def _create_client_instance(config: ResolvedLangSmithPluginConfig, client_cls: Any) -> Any:
    """创建 LangSmith 客户端实例.

    Args:
        config: 规范化后的配置.
        client_cls: LangSmith Client 类.

    Returns:
        客户端实例.
    """
    return client_cls(api_key=config.langsmith_api_key)


# TS 原文:
#   function createRunTreeFactory(
#     client: LangSmithClientLike,
#     RunTree: LangSmithRunTreeConstructor,
#   ): (params: Record<string, unknown>) => LangSmithRunTreeLike {
#     return (params) => new RunTree({ ...params, client });
#   }
#
# 语法对照:
#   (params) => new RunTree({...})  -- TS 的箭头函数(arrow function)
#   lambda params: RunTree(...)     -- Python 的 lambda (但这里逻辑稍复杂, 用 def 更清晰)
#
#   { ...params, client }           -- 对象展开 + 属性简写
#   -- 等价于: 把 params 的所有键值复制过来, 再加上 client: client
#   {**params, "client": client}    -- Python 字典解包


def _create_run_tree_factory(client: Any, run_tree_cls: Any):
    """构建一个 RunTree 工厂函数, 后续阶段用它来创建追踪树.

    Args:
        client: 已初始化的 LangSmith 客户端.
        run_tree_cls: RunTree 类.

    Returns:
        一个函数, 接受参数字典, 返回绑定了 client 的 RunTree 实例.
    """
    def factory(params: dict[str, Any]) -> Any:
        # TS: new RunTree({ ...params, client })
        return run_tree_cls(**params, client=client)
    return factory


# --------------------------------------------------------------------------- #
#  对外暴露的 API
# --------------------------------------------------------------------------- #

# TS 原文:
#   export function describeLangSmithRuntimeResult(result: LangSmithRuntimeResult): string {
#     switch (result.status) {
#       case "ready": return `...`;
#       case "disabled": return result.message;
#       case "unavailable": return result.message;
#     }
#   }
#
# 语法对照:
#   switch/case  -- TS 的分支语句, 类似 Python 3.10+ 的 match/case
#   `...${var}...` -- TS 的模板字符串(template literal), 类似 Python 的 f"...{var}..."


def describe_runtime_result(result: LangSmithRuntimeResult) -> str:
    """把运行时结果转成一行人类可读的日志.

    Args:
        result: 初始化结果.

    Returns:
        日志描述字符串.
    """
    # Python 3.10+ 的 match/case, 类似 TS 的 switch/case
    match result.status:
        case "ready":
            return f'LangSmith client is ready for project "{result.config.project_name}".'
        case "disabled":
            return result.message
        case "unavailable":
            return result.message
        case _:
            return result.message


# TS 原文:
#   export async function createLangSmithRuntime(
#     config: ResolvedLangSmithPluginConfig,
#   ): Promise<LangSmithRuntimeResult> { ... }
#
# 语法对照:
#   async function xxx(): Promise<Result>  -- TS 异步函数, 返回 Promise
#   async def xxx() -> Result:             -- Python 异步函数, 返回 coroutine
#
#   两者的使用方式几乎一样: 用 await 调用, 用 try/catch(except) 捕获异常


async def create_langsmith_runtime(
    config: ResolvedLangSmithPluginConfig,
) -> LangSmithRuntimeResult:
    """初始化 LangSmith 运行时, 返回结构化的结果(永远不抛异常).

    这是整个模块的核心函数. 它按顺序检查:
    1. 插件是否启用? 没启用 -> disabled
    2. 有没有 API Key? 没有 -> disabled
    3. SDK 能不能加载? 不能 -> unavailable
    4. 都通过 -> ready

    Args:
        config: 规范化后的配置.

    Returns:
        三种状态之一: disabled / unavailable / ready.
    """
    # 第一道检查: 插件是否启用
    if not config.enabled:
        return _create_disabled_result(
            config,
            "plugin_disabled",
            "LangSmith tracing is disabled by plugin config.",
        )

    # 第二道检查: 有没有 API Key
    if not config.langsmith_api_key:
        return _create_disabled_result(
            config,
            "missing_api_key",
            "LangSmith tracing is enabled but no langsmithApiKey was provided.",
        )

    # 第三步: 尝试加载 SDK 并创建客户端
    # TS: try { ... } catch (error) { ... }
    # PY: try: ... except Exception as error: ...
    try:
        sdk = _load_langsmith_sdk()
        client = _create_client_instance(config, sdk["Client"])
        return LangSmithRuntimeReady(
            message=f'LangSmith client initialized for project "{config.project_name}".',
            config=config,
            client=client,
            create_run_tree=_create_run_tree_factory(client, sdk["RunTree"]),
        )
    except Exception as error:
        # TS: error instanceof Error ? error.message : "..."
        # PY: Python 的异常都是 Exception 的子类, 直接用 str(error)
        message = (
            f"LangSmith SDK could not be loaded: {error}"
            if str(error)
            else "LangSmith SDK could not be loaded."
        )
        return _create_unavailable_result(config, "sdk_import_failed", message, error)
