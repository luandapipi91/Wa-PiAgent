// browser-tools.ts —— browser_* 宿主工具的执行逻辑。
//
// 由 AgentManager 的 bridgeCtx.handleTool 分派到本模块。每个工具返回
// BridgeToolResult（text content）。超时用 Promise.race 包装（WebView 部分
// 操作可能永久挂起）。截图默认落盘到 BrowserManager 的截图目录。
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { BridgeToolResult } from "./bridge-registry";
import type { BrowserManager } from "./browser-manager";

const NAVIGATE_TIMEOUT_MS = 120_000;
const OPERATION_TIMEOUT_MS = 60_000;
const EVAL_RESULT_MAX_CHARS = 8_000;

function textResult(text: string, details: Record<string, unknown> = {}): BridgeToolResult {
  return { content: [{ type: "text", text }], details };
}

function errResult(text: string, error: string): BridgeToolResult {
  return { content: [{ type: "text", text }], details: { error } };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 判断是否 WebView 引擎不可用（非 macOS 未装 Chrome/Edge 等） */
function isEngineUnavailable(msg: string): boolean {
  return /spawn.*(ENOENT|not found)|executable.*not found|WebView is not available/i.test(msg);
}

/** 带超时的 Promise 包装：超时 reject，避免永久挂起 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 执行 WebView 操作并处理并发槽冲突：Bun.WebView 每种操作单槽位，并发调用抛
 * ERR_INVALID_STATE（不排队）。此处短等待后重试最多 3 次（100ms 间隔），
 * 规避 LLM 并行调用同一视图时的偶发冲突。
 */
async function runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  const MAX_RETRIES = 3;
  let lastErr: unknown;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = errMessage(err);
      if (!msg.includes("ERR_INVALID_STATE") || i === MAX_RETRIES) throw err;
      await Bun.sleep(100 * (i + 1));
    }
  }
  throw lastErr;
}

/** 统一包装 WebView 操作的超时 + 并发重试 */
async function runViewOp<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return withTimeout(runWithRetry(fn), ms, label);
}

/** 过滤 undefined 字段，避免把 { button: undefined } 传给 WebView（Bun 侧按缺省处理，但显式 undefined 字段在不同版本可能抛错） */
function cleanOpts<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function arr(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

/** 入口：按工具名分派（未知工具返回错误） */
export async function handleBrowserTool(
  manager: BrowserManager,
  sessionId: string,
  tool: string,
  params: unknown,
): Promise<BridgeToolResult> {
  switch (tool) {
    case "browser_navigate":
      return navigateTool(manager, sessionId, params);
    case "browser_evaluate":
      return evaluateTool(manager, sessionId, params);
    case "browser_screenshot":
      return screenshotTool(manager, sessionId, params);
    case "browser_close":
      return closeTool(manager, sessionId);
    default:
      return errResult(`未知 browser 工具: ${tool}`, "unknown_tool");
  }
}

async function navigateTool(
  manager: BrowserManager,
  sessionId: string,
  params: unknown,
): Promise<BridgeToolResult> {
  const p = params as { url?: unknown; width?: unknown; height?: unknown; timeout?: unknown };
  const url = str(p.url);
  if (!url) {
    return errResult("browser_navigate 需要 url 参数（string）", "missing_url");
  }
  const timeoutMs = typeof p.timeout === "number" ? p.timeout : NAVIGATE_TIMEOUT_MS;
  try {
    const state = await manager.getOrCreate(sessionId, {
      width: num(p.width),
      height: num(p.height),
    });
    await runViewOp(() => state.view.navigate(url), timeoutMs, "页面加载");
    const result = { ok: true, sessionId, url: state.view.url, title: state.view.title, loading: state.view.loading };
    return textResult(JSON.stringify(result), result);
  } catch (err) {
    const msg = errMessage(err);
    if (isEngineUnavailable(msg)) {
      return errResult(
        `浏览器引擎不可用：${msg}。非 macOS 平台需要已安装 Chrome/Chromium/Edge/Brave（或设置 BUN_CHROME_PATH 环境变量指定浏览器可执行文件路径）`,
        "engine_unavailable",
      );
    }
    return errResult(`导航失败: ${msg}`, msg);
  }
}

async function evaluateTool(
  manager: BrowserManager,
  sessionId: string,
  params: unknown,
): Promise<BridgeToolResult> {
  const state = manager.get(sessionId);
  if (!state) {
    return errResult(
      "浏览器视图未创建：请先调用 browser_navigate 打开页面",
      "no_view",
    );
  }
  const view = state.view;
  const p = params as Record<string, unknown>;
  const action = str(p.action);
  if (!action) {
    return errResult("browser_evaluate 需要 action 参数", "missing_action");
  }
  try {
    switch (action) {
      case "eval": {
        const script = str(p.script);
        if (!script) return errResult("action=eval 需要 script 参数", "missing_script");
        const raw = await runViewOp(() => view.evaluate(script), OPERATION_TIMEOUT_MS, "evaluate");
        // 先序列化最终 payload 再截断（此前截断作用于局部 text，返回时重新序列化导致截断失效）
        let payload: string;
        try {
          payload = JSON.stringify({ ok: true, result: raw });
        } catch {
          payload = JSON.stringify({ ok: true, result: String(raw) });
        }
        if (payload.length > EVAL_RESULT_MAX_CHARS) {
          payload = payload.slice(0, EVAL_RESULT_MAX_CHARS) + `…（截断，原长 ${payload.length}）`;
        }
        return textResult(payload, { ok: true });
      }
      case "click": {
        const selector = str(p.selector);
        if (selector) {
          await runViewOp(
            () => view.click(selector, cleanOpts({ button: str(p.button), modifiers: arr(p.modifiers), clickCount: num(p.clickCount), timeout: num(p.timeout) })),
            OPERATION_TIMEOUT_MS,
            "click",
          );
        } else if (typeof p.x === "number" && typeof p.y === "number") {
          // 先收窄到 const，否则 typeof 收窄不会传播进闭包（p 是可变 Record）
          const x = p.x;
          const y = p.y;
          await runViewOp(
            () => view.click(x, y, cleanOpts({ button: str(p.button), modifiers: arr(p.modifiers), clickCount: num(p.clickCount) })),
            OPERATION_TIMEOUT_MS,
            "click",
          );
        } else {
          return errResult("action=click 需要 selector 或 x/y 坐标", "missing_click_target");
        }
        return textResult(JSON.stringify({ ok: true, action: "click" }), { ok: true });
      }
      case "type": {
        const text = str(p.text);
        if (!text) return errResult("action=type 需要 text 参数", "missing_text");
        await runViewOp(() => view.type(text), OPERATION_TIMEOUT_MS, "type");
        return textResult(JSON.stringify({ ok: true, action: "type" }), { ok: true });
      }
      case "press": {
        const key = str(p.key);
        if (!key) return errResult("action=press 需要 key 参数", "missing_key");
        await runViewOp(() => view.press(key, cleanOpts({ modifiers: arr(p.modifiers) })), OPERATION_TIMEOUT_MS, "press");
        return textResult(JSON.stringify({ ok: true, action: "press" }), { ok: true });
      }
      case "scroll": {
        const dx = num(p.dx) ?? 0;
        const dy = num(p.dy) ?? 0;
        await runViewOp(() => view.scroll(dx, dy), OPERATION_TIMEOUT_MS, "scroll");
        return textResult(JSON.stringify({ ok: true, action: "scroll" }), { ok: true });
      }
      case "scrollTo": {
        const selector = str(p.selector);
        if (!selector) return errResult("action=scrollTo 需要 selector 参数", "missing_selector");
        await runViewOp(
          () => view.scrollTo(selector, cleanOpts({ block: str(p.block), timeout: num(p.timeout) })),
          OPERATION_TIMEOUT_MS,
          "scrollTo",
        );
        return textResult(JSON.stringify({ ok: true, action: "scrollTo" }), { ok: true });
      }
      default:
        return errResult(`未知 action: ${action}（可选 eval/click/type/press/scroll/scrollTo）`, "unknown_action");
    }
  } catch (err) {
    return errResult(
      `browser_evaluate ${action} 失败: ${errMessage(err)}；当前页面 ${view.url} (${view.title})`,
      errMessage(err),
    );
  }
}

async function screenshotTool(
  manager: BrowserManager,
  sessionId: string,
  params: unknown,
): Promise<BridgeToolResult> {
  const state = manager.get(sessionId);
  if (!state) {
    return errResult("浏览器视图未创建：请先调用 browser_navigate 打开页面", "no_view");
  }
  const p = params as { format?: unknown; quality?: unknown; return?: unknown };
  const format = str(p.format) ?? "png";
  const quality = num(p.quality);
  const returnMode = str(p.return) ?? "path";
  try {
    if (returnMode === "base64") {
      const b64 = (await runViewOp(
        () => state.view.screenshot({ format, quality, encoding: "base64" }),
        OPERATION_TIMEOUT_MS,
        "screenshot",
      )) as string;
      const dataUrl = `data:image/${format === "jpeg" ? "jpeg" : format === "webp" ? "webp" : "png"};base64,${b64}`;
      const result = { ok: true, base64: dataUrl, url: state.view.url, title: state.view.title };
      return textResult(JSON.stringify(result), result);
    }
    // path 模式：落盘到截图目录
    const buf = (await runViewOp(
      () => state.view.screenshot({ format, quality, encoding: "buffer" }),
      OPERATION_TIMEOUT_MS,
      "screenshot",
    )) as Buffer;
    const filename = `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}-${randomUUID().slice(0, 8)}.${format === "jpeg" ? "jpg" : format}`;
    const path = join(manager.getScreenshotDir(), filename);
    writeFileSync(path, buf);
    const result = { ok: true, path, url: state.view.url, title: state.view.title, format, sizeBytes: buf.length };
    return textResult(JSON.stringify(result), result);
  } catch (err) {
    return errResult(`截图失败: ${errMessage(err)}`, errMessage(err));
  }
}

async function closeTool(manager: BrowserManager, sessionId: string): Promise<BridgeToolResult> {
  const existed = manager.get(sessionId) !== undefined;
  manager.closeSession(sessionId);
  const result = { ok: true, closed: existed };
  return textResult(JSON.stringify(result), result);
}
