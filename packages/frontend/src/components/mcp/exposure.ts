// MCP 暴露方式（exposure）的单一事实来源：表单下拉、卡片标签都从这里取，
// 保证「五档」不会在两个组件里各写一遍而漂移。
//
// 官方语义（pi 内置 MCP 扩展）：
//   direct            —— 工具直接声明给模型，模型可随时调用
//   codemode          —— 工具只能在代码脚本里调用（模型需先写脚本）
//   codemode-deferred —— 同 codemode，但工具清单按需加载（省上下文）
//   deferred          —— 工具按需检索加载
//   hidden            —— 服务器连接并注册工具，但不暴露给模型
import type { McpExposure } from "@wa-pi/shared";

/** 下拉选项顺序（与规格 §4.2 一致：direct 在最前） */
export const MCP_EXPOSURES: readonly McpExposure[] = [
  "direct",
  "codemode",
  "codemode-deferred",
  "deferred",
  "hidden",
];

/**
 * 新建服务器的默认暴露方式。
 *
 * 产品决策（规格 §4.2）：取 direct 而不是 pi 的官方默认 codemode ——
 * 保持 Wa-Pi 既有「工具可见、可勾选」的交互；codemode 会改变模型可见的工具集。
 */
export const DEFAULT_MCP_EXPOSURE: McpExposure = "direct";

/** i18n 键的驼峰段：codemode-deferred → CodemodeDeferred */
function camel(exposure: McpExposure): string {
  return exposure
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

/** 短标签（下拉选项 / 卡片徽标）：mcpForm.exposureDirect… */
export function exposureLabelKey(exposure: McpExposure): string {
  return `mcpForm.exposure${camel(exposure)}`;
}

/** 一句用户能懂的说明（表单里跟随所选档位展示）：mcpForm.exposureDirectDesc… */
export function exposureDescKey(exposure: McpExposure): string {
  return `mcpForm.exposure${camel(exposure)}Desc`;
}
