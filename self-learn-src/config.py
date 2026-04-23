"""
config.py -- config.ts 的 Python 对照翻译

全局概述:
本模块负责 Phase 2 中 LangSmith 插件的配置契约(config contract).
它把三件事集中在一个地方:
- 声明插件的配置结构(schema), 让 OpenClaw 可以校验
- 把用户填的原始输入规范化(normalize)成一个稳定的运行时形状(runtime shape)
- 暴露一些小工具函数, 让后续阶段不用重复写配置逻辑

======== TypeScript vs Python 语法对照笔记 ========

1. 类型定义:
   TS: type LangSmithPluginConfig = { enabled?: boolean; ... }
   PY: 用 TypedDict 或 dataclass. Python 的类型注解只是"标签", 运行时不强制检查.

2. 可选字段:
   TS: enabled?: boolean    -- 问号表示"可以不填, 不填就是 undefined"
   PY: enabled: bool | None = None

3. 导出/导入:
   TS: export function xxx / import { xxx } from "./config.js"
   PY: 直接定义函数即可, 用 from config import xxx

4. const vs 普通变量:
   TS: const DEFAULT_XXX = { ... }  -- const 表示变量绑定不可变(但对象内容仍可变)
   PY: 约定用全大写命名表示常量, 但 Python 本身不阻止你修改它

5. zod 验证库:
   TS: z.strictObject({ enabled: z.boolean().default(true).optional() })
   PY: 对应 pydantic 的 BaseModel, 或手写验证逻辑

6. 联合类型返回值:
   TS: function(): { success: true; data: X } | { success: false; error: Y }
   PY: 用 dataclass + Literal 类型, 或简单用 dict
"""

from __future__ import annotations  # 允许类型注解中使用尚未定义的类名

from dataclasses import dataclass, field
from typing import Any


# --------------------------------------------------------------------------- #
#  类型定义 (对应 TS 的 type 关键字)
# --------------------------------------------------------------------------- #

# TS 原文:
#   export type LangSmithPluginConfig = {
#     enabled?: boolean;
#     langsmithApiKey?: string;
#     projectName?: string;
#     debug?: boolean;
#   };
#
# Python 翻译:
#   用 dataclass 代替 TS 的 type. 每个字段都有默认值 None, 对应 TS 的 "?" 可选标记.


@dataclass
class LangSmithPluginConfig:
    """用户在 OpenClaw 配置文件中填写的原始插件配置.

    所有字段都是可选的(Optional), 用户没填的就是 None.
    """
    enabled: bool | None = None
    langsmith_api_key: str | None = None     # TS: langsmithApiKey (驼峰 -> 蛇形)
    project_name: str | None = None          # TS: projectName
    debug: bool | None = None


# TS 原文:
#   export type ResolvedLangSmithPluginConfig = {
#     enabled: boolean;          <-- 注意: 没有问号, 表示必须有值
#     langsmithApiKey?: string;  <-- 仍然可选, 因为可能用户没填
#     projectName: string;       <-- 必须有值(会用默认值填充)
#     debug: boolean;            <-- 必须有值
#   };


@dataclass
class ResolvedLangSmithPluginConfig:
    """规范化之后的运行时配置.

    和上面的 LangSmithPluginConfig 的区别:
    - enabled, project_name, debug 一定有值(用默认值填充了)
    - 只有 langsmith_api_key 仍然可能是 None
    """
    enabled: bool
    project_name: str
    debug: bool
    langsmith_api_key: str | None = None


# TS 原文:
#   export type LangSmithPluginConfigParseResult = {
#     config: ResolvedLangSmithPluginConfig;
#     hasUserSuppliedConfig: boolean;
#     issues: string[];
#   };


@dataclass
class LangSmithPluginConfigParseResult:
    """解析结果: 包含规范化后的配置 + 一些元数据.

    - config: 规范化后的配置, 可以直接使用
    - has_user_supplied_config: 用户是否真的填了配置(还是空的 {})
    - issues: 验证过程中发现的问题列表(不会抛异常, 只记录)
    """
    config: ResolvedLangSmithPluginConfig
    has_user_supplied_config: bool
    issues: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- #
#  默认值 (对应 TS 的 export const)
# --------------------------------------------------------------------------- #

# TS 原文:
#   export const DEFAULT_LANGSMITH_PLUGIN_CONFIG: ResolvedLangSmithPluginConfig = {
#     enabled: true,
#     projectName: "openclaw",
#     debug: false,
#   };
#
# Python 翻译:
#   直接实例化一个 dataclass 作为默认值. 全大写表示"当常量用".

DEFAULT_LANGSMITH_PLUGIN_CONFIG = ResolvedLangSmithPluginConfig(
    enabled=True,
    project_name="openclaw",
    debug=False,
    langsmith_api_key=None,
)


# --------------------------------------------------------------------------- #
#  工具函数 (对应 TS 的 function)
# --------------------------------------------------------------------------- #

# TS 原文:
#   function normalizeOptionalString(value: string | undefined): string | undefined {
#     const normalized = value?.trim();
#     return normalized ? normalized : undefined;
#   }
#
# 语法对照:
#   value?.trim()  -- TS 的可选链(optional chaining), 如果 value 是 undefined 就不调用 trim
#   Python 没有 ?. 语法, 需要手动判断 None


def normalize_optional_string(value: str | None) -> str | None:
    """去掉前后空格, 如果结果是空字符串就返回 None.

    Args:
        value: 用户填的原始字符串, 可能是 None.

    Returns:
        有意义的字符串, 或 None.
    """
    if value is None:
        return None
    normalized = value.strip()    # 对应 TS 的 .trim()
    return normalized if normalized else None
    # TS:  return normalized ? normalized : undefined;
    # 这里的 ? : 是三元运算符, Python 用 X if COND else Y


# TS 原文:
#   function hasUserSuppliedPluginConfig(value: unknown): boolean {
#     if (!value || typeof value !== "object" || Array.isArray(value)) {
#       return false;
#     }
#     return Object.keys(value as Record<string, unknown>).length > 0;
#   }
#
# 语法对照:
#   unknown      -- TS 的"任意类型但类型安全"的类型, 类似 Python 的 Any
#   typeof value -- TS 检查运行时类型的操作符
#   value as Record<string, unknown> -- 类型断言(type assertion), 告诉编译器"我确定它是这个类型"


def has_user_supplied_plugin_config(value: Any) -> bool:
    """判断用户是否真的提供了插件配置.

    避免在用户只是安装了插件但没配置时发出不必要的警告.

    Args:
        value: 原始的 api.pluginConfig 值.

    Returns:
        True 表示用户确实填了至少一个配置项.
    """
    if not value or not isinstance(value, dict):
        return False
    return len(value) > 0


# --------------------------------------------------------------------------- #
#  核心: 构建规范化配置
# --------------------------------------------------------------------------- #

# TS 原文:
#   function buildResolvedLangSmithPluginConfig(
#     rawConfig: LangSmithPluginConfig | undefined,
#   ): ResolvedLangSmithPluginConfig { ... }
#
# 语法对照:
#   rawConfig?.enabled ?? DEFAULT_XXX.enabled
#   ?.  -- 可选链: rawConfig 为 undefined 时短路返回 undefined
#   ??  -- 空值合并: 左边是 null/undefined 时用右边的值
#   Python 没有这两个操作符, 需要用 if/else 或 getattr 实现


def build_resolved_config(
    raw_config: LangSmithPluginConfig | None,
) -> ResolvedLangSmithPluginConfig:
    """把用户的原始配置合并上默认值, 得到一个完整的运行时配置.

    Args:
        raw_config: 用户填的配置, 或 None(用户什么都没填).

    Returns:
        所有必填字段都有值的配置对象.
    """
    if raw_config is None:
        # 用户什么都没填, 全用默认值
        return ResolvedLangSmithPluginConfig(
            enabled=DEFAULT_LANGSMITH_PLUGIN_CONFIG.enabled,
            langsmith_api_key=None,
            project_name=DEFAULT_LANGSMITH_PLUGIN_CONFIG.project_name,
            debug=DEFAULT_LANGSMITH_PLUGIN_CONFIG.debug,
        )

    # TS: rawConfig?.enabled ?? DEFAULT_XXX.enabled
    # Python: 如果 raw_config.enabled 是 None, 就用默认值
    return ResolvedLangSmithPluginConfig(
        enabled=(
            raw_config.enabled
            if raw_config.enabled is not None
            else DEFAULT_LANGSMITH_PLUGIN_CONFIG.enabled
        ),
        langsmith_api_key=normalize_optional_string(raw_config.langsmith_api_key),
        project_name=(
            normalize_optional_string(raw_config.project_name)
            or DEFAULT_LANGSMITH_PLUGIN_CONFIG.project_name
            # TS: normalizeOptionalString(rawConfig?.projectName) ?? DEFAULT_XXX
            # 这里用 or 代替 ??, 因为 normalize 返回 None 或非空字符串
        ),
        debug=(
            raw_config.debug
            if raw_config.debug is not None
            else DEFAULT_LANGSMITH_PLUGIN_CONFIG.debug
        ),
    )


# --------------------------------------------------------------------------- #
#  配置验证 (对应 TS 的 zod schema + safeParse)
# --------------------------------------------------------------------------- #

# TS 原文使用 zod 库来做运行时验证:
#   const LangSmithPluginConfigSource = z.strictObject({
#     enabled: z.boolean().default(true).optional(),
#     ...
#   });
#
# Python 翻译:
#   手写验证逻辑. 在正式项目中可以用 pydantic 替代, 和 zod 的理念非常相似.


def _validate_raw_config(value: Any) -> tuple[LangSmithPluginConfig | None, list[str]]:
    """验证原始配置字典的每个字段, 收集所有问题(不抛异常).

    Args:
        value: 用户传入的原始配置(通常是 dict).

    Returns:
        (解析后的配置或None, 问题列表).
    """
    if value is None:
        return None, []

    if not isinstance(value, dict):
        return None, ["config must be an object"]

    issues: list[str] = []
    raw = LangSmithPluginConfig()

    # --- 验证 enabled ---
    if "enabled" in value:
        if isinstance(value["enabled"], bool):
            raw.enabled = value["enabled"]
        else:
            issues.append("enabled: expected boolean")

    # --- 验证 langsmithApiKey ---
    if "langsmithApiKey" in value:
        v = value["langsmithApiKey"]
        if isinstance(v, str) and len(v.strip()) > 0:
            raw.langsmith_api_key = v
        else:
            issues.append("langsmithApiKey: expected non-empty string")

    # --- 验证 projectName ---
    if "projectName" in value:
        v = value["projectName"]
        if isinstance(v, str) and len(v.strip()) > 0:
            raw.project_name = v
        else:
            issues.append("projectName: expected non-empty string")

    # --- 验证 debug ---
    if "debug" in value:
        if isinstance(value["debug"], bool):
            raw.debug = value["debug"]
        else:
            issues.append("debug: expected boolean")

    # --- 检查是否有多余的未知字段 (对应 z.strictObject) ---
    known_keys = {"enabled", "langsmithApiKey", "projectName", "debug"}
    for key in value:
        if key not in known_keys:
            issues.append(f"{key}: unrecognized config key")

    if issues:
        return None, issues
    return raw, []


# TS 原文:
#   function safeParseLangSmithPluginConfig(value: unknown):
#     | { success: true; data: ResolvedLangSmithPluginConfig }
#     | { success: false; error: { issues: ... } }
#
# 语法对照:
#   TS 的联合类型返回值(|): 函数可能返回"成功对象"或"失败对象", 两种形状不同
#   Python 的 dataclass 可以实现类似效果, 这里为了简洁直接用 dict


def safe_parse_config(value: Any) -> dict[str, Any]:
    """安全地解析配置, 永远不抛异常.

    这是 zod 的 .safeParse() 的 Python 等价物:
    - 成功: {"success": True, "data": ResolvedLangSmithPluginConfig}
    - 失败: {"success": False, "issues": ["...", "..."]}

    Args:
        value: 原始配置值.

    Returns:
        解析结果字典.
    """
    if value is None:
        return {
            "success": True,
            "data": build_resolved_config(None),
        }

    raw_config, issues = _validate_raw_config(value)
    if issues:
        return {
            "success": False,
            "issues": issues,
        }

    return {
        "success": True,
        "data": build_resolved_config(raw_config),
    }


# --------------------------------------------------------------------------- #
#  对外暴露的 API (对应 TS 的 export function)
# --------------------------------------------------------------------------- #

# TS 原文:
#   export function parseLangSmithPluginConfig(value: unknown): LangSmithPluginConfigParseResult


def parse_langsmith_plugin_config(value: Any) -> LangSmithPluginConfigParseResult:
    """解析原始插件配置, 返回规范化结果 + 元数据.

    这是入口文件(index.py)调用的主函数.

    Args:
        value: 原始的 api.pluginConfig 值.

    Returns:
        包含规范化配置、是否有用户配置、以及问题列表的结果.
    """
    parsed = safe_parse_config(value)

    if parsed["success"]:
        return LangSmithPluginConfigParseResult(
            config=parsed["data"],
            has_user_supplied_config=has_user_supplied_plugin_config(value),
            issues=[],
        )

    return LangSmithPluginConfigParseResult(
        config=build_resolved_config(None),
        has_user_supplied_config=has_user_supplied_plugin_config(value),
        issues=parsed["issues"],
    )


# TS 原文:
#   export function isLangSmithConfigured(config: ResolvedLangSmithPluginConfig): boolean {
#     return config.enabled && Boolean(config.langsmithApiKey);
#   }
#
# 语法对照:
#   Boolean(xxx) -- TS 中把值转为布尔值, 类似 Python 的 bool(xxx)
#   &&           -- 逻辑与, Python 用 and


def is_langsmith_configured(config: ResolvedLangSmithPluginConfig) -> bool:
    """判断 LangSmith 追踪功能是否真正可以启动.

    必须同时满足:
    1. enabled 为 True (用户没关掉)
    2. langsmith_api_key 不为空 (有 API 密钥)

    Args:
        config: 规范化后的配置.

    Returns:
        True 表示可以初始化 LangSmith 客户端.
    """
    return config.enabled and bool(config.langsmith_api_key)
