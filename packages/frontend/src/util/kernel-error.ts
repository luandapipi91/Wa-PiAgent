/**
 * kernel 结构化错误的渲染出口：code → i18n 字典文案（kernelMsg 段）+ params 插值。
 *
 * 背景：kernel 侧（ws-server replyError / classifySdkError / provider-test）把
 * 面向用户的错误编码为 { code, params, detail }，文案不再由 kernel 拼中文——
 * 前端按 code 查 kernelMsg 字典渲染，detail 是技术细节（默认不混入主文案）。
 *
 * 兼容：老 kernel / 未迁移模块的错误只有 message（或普通字符串），
 * 无 code 时原样展示，行为不变。
 *
 * i18n 用法：非 React 上下文（store/util），沿用 store/mcp.ts 的
 * `import i18n from "../i18n"` + i18n.t 先例（非 hook）。
 */
import i18n from "../i18n";

/** kernel 错误载荷的宽松形状（兼容结构化 / 纯 message 两种来源） */
export interface KernelErrorLike {
  code?: string;
  params?: Record<string, string | number>;
  detail?: string;
  message?: string;
}

/**
 * 格式化 kernel 错误：结构化载荷按 code 查字典 + params 插值；
 * 未知 code 兜底 kernelMsg.unknown；无 code 走 message 原样展示。
 */
export function formatKernelError(p: KernelErrorLike): {
  main: string;
  detail?: string;
} {
  // 无 code：旧 kernel / 未迁移模块的纯 message，原样展示（兼容）
  if (!p.code) return { main: p.message ?? "" };
  const key = `kernelMsg.${p.code}`;
  const unknown = i18n.t("kernelMsg.unknown");
  // params 直接展开给 i18next 做插值（如 {{status}}）；查不到 code 时兜底 unknown
  const main = i18n.t(key, { ...p.params, defaultValue: unknown });
  return { main, detail: p.detail };
}

/**
 * HTTP 层错误的一站式格式化：ApiError.failure 按 code 渲染；
 * 无 failure（老 kernel / 网络错误 / 非 Error 值）时原样展示。供 catch 处直接调用。
 *
 * 用鸭子类型识别 ApiError（不模块顶层依赖 api-client：组件测试常 mock api-client，
 * 顶层 import 会因 mock 缺少 ApiError 导出而崩）。
 */
export function formatApiError(e: unknown): string {
  const failure =
    typeof e === "object" && e !== null && "failure" in e
      ? (e as { failure?: KernelErrorLike }).failure
      : undefined;
  const message = e instanceof Error ? e.message : String(e);
  return formatKernelError(failure ?? { message }).main;
}
