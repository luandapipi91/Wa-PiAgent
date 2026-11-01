// browser-tools.ts —— browser_* 宿主工具的执行逻辑。
//
// 由 AgentManager 的 bridgeCtx.handleTool 分派到本模块。每个工具返回
// BridgeToolResult（text content）。超时用 Promise.race 包装（WebView 部分
// 操作可能永久挂起）。截图默认落盘到 BrowserManager 的截图目录。
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { BridgeToolResult } from "./bridge-registry";
import type {
  BrowserManager,
  BrowserViewState,
  ElementRef,
} from "./browser-manager";
import {
  ANNOTATE_SCRIPT,
  DISMISS_SCRIPT,
  MODAL_PROBE,
  SNAPSHOT_SCRIPT,
  captureStableSnapshot,
  clickTextScript,
  hoverLocateScript,
  diffSnapshotLines,
  formatSnapshot,
  resolveRefScript,
} from "./browser-annotate";

const NAVIGATE_TIMEOUT_MS = 120_000;
const OPERATION_TIMEOUT_MS = 60_000;
const EVAL_RESULT_MAX_CHARS = 8_000;

function textResult(
  text: string,
  details: Record<string, unknown> = {},
): BridgeToolResult {
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
  return /spawn.*(ENOENT|not found)|executable.*not found|WebView is not available/i.test(
    msg,
  );
}

/** 带超时的 Promise 包装：超时 reject，避免永久挂起 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
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
async function runViewOp<T>(
  fn: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
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
  return Array.isArray(v) && v.every((x) => typeof x === "string")
    ? (v as string[])
    : undefined;
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
    case "browser_snapshot":
      return snapshotTool(manager, sessionId, params);
    case "browser_read":
      return readTool(manager, sessionId, params);
    case "browser_wait":
      return waitTool(manager, sessionId, params);
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
  const p = params as {
    url?: unknown;
    width?: unknown;
    height?: unknown;
    timeout?: unknown;
    snapshot?: unknown;
    fresh?: unknown;
  };
  const url = str(p.url);
  if (!url) {
    return errResult("browser_navigate 需要 url 参数（string）", "missing_url");
  }
  const timeoutMs =
    typeof p.timeout === "number" ? p.timeout : NAVIGATE_TIMEOUT_MS;
  try {
    const state = await manager.getOrCreate(sessionId, {
      width: num(p.width),
      height: num(p.height),
    });
    // headless UA → 同机桌面 Chrome UA（首次导航前；失败静默跳过不阻断导航）
    await manager.prepareUserAgent?.(state);
    // 同站 hash 路由跳转：目标 URL 与当前页面同 origin 且带 hash 时，直接 eval 改
    // location.hash——WebView.navigate 对 SPA hash 路由会等 load 事件挂起到超时
    // （第五轮实测 120s，页面实际早已渲染）。blob: 文档的 origin 即来源站点 origin，
    // 同样命中本分支。
    try {
      const cur = new URL(state.view.url);
      const tgt = new URL(url);
      if (
        cur.origin === tgt.origin &&
        tgt.hash &&
        tgt.hash !== cur.hash &&
        state.view.url !== "about:blank"
      ) {
        await runViewOp(
          () =>
            state.view.evaluate(
              // IIFE 单表达式（evaluate 是表达式语义，裸多语句语法错误）；
              // location.hash 赋值触发同文档导航，绝不能用裸语句
              `(() => { location.hash = ${JSON.stringify(tgt.hash)}; return "ok"; })()`,
            ),
          OPERATION_TIMEOUT_MS,
          "hash 跳转",
        );
        const result = {
          ok: true,
          sessionId,
          url: state.view.url,
          title: state.view.title,
          loading: state.view.loading,
          hashNav: true,
        };
        if (p.snapshot !== false) await attachAutoSnapshot(state, result);
        return textResult(JSON.stringify(result), result);
      }
    } catch {
      // URL 解析失败（如 about:blank）→ 走正常导航
    }
    await runViewOp(() => state.view.navigate(url), timeoutMs, "页面加载");
    // fresh：清当前 origin 登录态（localStorage/sessionStorage/非 HttpOnly cookie）后刷新，
    // 回归测试干净起步——清除必须在目标页面上下文里做（localStorage 按 origin 隔离），
    // 故先航到目标再清再刷。
    let fresh = false;
    if (p.fresh === true) {
      // CDP 清全部 cookie（含 HttpOnly 的会话恢复凭据——document.cookie 无权清除，
      // 清完存储 SPA 仍会自动重登，第十五轮实测）。CDP 不可用时降级 document.cookie。
      try {
        if (typeof state.view.cdp === "function") {
          await state.view.cdp("Network.clearBrowserCookies", {});
        }
      } catch {
        // 降级到脚本内 document.cookie 清理
      }
      // 清存储 + location.reload 同一次 evaluate：reload 不占导航槽，避免
      // 双 navigate 在慢首载时连锁 navigation already pending（第四轮验收实测）
      await runViewOp(
        () =>
          state.view.evaluate(
            "(() => { try { localStorage.clear(); sessionStorage.clear(); const ks = document.cookie.split(';'); for (const k of ks) document.cookie = k.split('=')[0] + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/'; } catch {} location.reload(); return 'reloading'; })()",
          ),
        OPERATION_TIMEOUT_MS,
        "fresh 清理+刷新",
      );
      fresh = true;
    }
    // 导航后 DOM 更换，上一轮 annotate 的 ref 全部失效，清空缓存（refs 属性引用的旧元素已不存在）
    state.refs = undefined;
    const result = {
      ok: true,
      sessionId,
      url: state.view.url,
      title: state.view.title,
      loading: state.view.loading,
      fresh: fresh ? true : undefined,
    };
    // 操作后自动附文本快照（差值+稳定检测；snapshot:false 跳过）。
    // 导航是「从零到有」的最大等待场景，SPA 首屏挂载实测可超 3s（美管家）——预算提到
    // 16 帧（~4s），对齐 dagu（5s）的业界上限量级；稳定即提前返回，快站不受影响。
    if (p.snapshot !== false)
      await attachAutoSnapshot(state, result, { maxFrames: 16 });
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
  const wantSnapshot = p.snapshot !== false;
  const action = str(p.action);
  if (!action) {
    return errResult("browser_evaluate 需要 action 参数", "missing_action");
  }
  try {
    switch (action) {
      case "eval": {
        const script = str(p.script);
        if (!script)
          return errResult("action=eval 需要 script 参数", "missing_script");
        const raw = await runViewOp(
          () => view.evaluate(script),
          OPERATION_TIMEOUT_MS,
          "evaluate",
        );
        // 先序列化最终 payload 再截断（此前截断作用于局部 text，返回时重新序列化导致截断失效）
        let payload: string;
        try {
          payload = JSON.stringify({ ok: true, result: raw });
        } catch {
          payload = JSON.stringify({ ok: true, result: String(raw) });
        }
        if (payload.length > EVAL_RESULT_MAX_CHARS) {
          payload =
            payload.slice(0, EVAL_RESULT_MAX_CHARS) +
            `…（截断，原长 ${payload.length}）`;
        }
        return textResult(payload, { ok: true });
      }
      case "hover": {
        // 悬停：定位元素中心后经 CDP 派发真实 mouseMoved（isTrusted），触发 ant 等
        // 组件的 mouseenter 悬停下拉——合成事件（el.dispatchEvent）触发不了，这是
        // 后台系统导航的最大坑。定位优先级与 click 相同：selector 优先，其次文本。
        const hasCdp = typeof view.cdp === "function";
        if (!hasCdp) {
          return errResult(
            "hover 需要支持 CDP 的 Chrome 后端（当前引擎不可用）",
            "hover_unavailable",
          );
        }
        const hoverSelector = str(p.selector);
        const hoverText = str(p.text);
        if (hoverSelector === undefined && hoverText === undefined) {
          return errResult(
            "action=hover 需要 selector 或 text 参数",
            "missing_hover_target",
          );
        }
        const loc = (await runViewOp(
          () =>
            view.evaluate(
              hoverLocateScript({ selector: hoverSelector, text: hoverText }),
            ),
          OPERATION_TIMEOUT_MS,
          "hover",
        )) as { found?: boolean; x?: number; y?: number; label?: string } | undefined;
        if (!loc || loc.found !== true || typeof loc.x !== "number" || typeof loc.y !== "number") {
          return errResult(
            `未找到悬停目标（${hoverSelector ?? `文本 "${hoverText}"`}）；可先用 browser_snapshot 查看页面`,
            "hover_target_not_found",
          );
        }
        const hx = loc.x;
        const hy = loc.y;
        await runViewOp(
          () =>
            view.cdp!("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: hx,
              y: hy,
              button: "none",
              pointerType: "mouse",
            }),
          OPERATION_TIMEOUT_MS,
          "hover move",
        );
        return opResult(
          state,
          { ok: true, action: "hover", hovered: loc.label ?? hoverSelector ?? hoverText, x: hx, y: hy },
          wantSnapshot,
        );
      }
      case "dismissModals": {
        // 弹窗清除：直接移除 ant 系模态节点（第六/十二轮实测比点关闭按钮可靠），
        // 返回移除数量；附自动快照让 agent 立即看到干净后的页面
        const removed = await runViewOp(
          () => view.evaluate(DISMISS_SCRIPT),
          OPERATION_TIMEOUT_MS,
          "dismissModals",
        );
        return opResult(
          state,
          { ok: true, action: "dismissModals", removed: Number(removed) || 0 },
          wantSnapshot,
        );
      }
      case "click": {
        // ref 编号定位（优先于 selector/x/y）：来自最近一次 annotate 截图的 refs。
        // 每次点击前实时重查元素位置（先 scrollIntoView 再取中心），页面重排也能点准；
        // 元素已消失或缓存缺失一律报 invalid_ref——宁失效不错点。
        // 格式容错：快照显示为 @N，模型常传 "@3" 或 "3"，与数字 3 等价解析
        const ref =
          typeof p.ref === "number" && Number.isInteger(p.ref)
            ? p.ref
            : typeof p.ref === "string"
              ? (() => {
                  const m = p.ref.trim().match(/^@?(\d+)$/);
                  return m ? Number(m[1]) : undefined;
                })()
              : undefined;
        if (p.ref !== undefined) {
          if (ref === undefined || !Number.isInteger(ref) || ref < 1) {
            return errResult(
              `ref 需为正整数或 "@N" 格式，收到 ${JSON.stringify(p.ref)}`,
              "invalid_ref",
            );
          }
          if (!state.refs?.[`@${ref}`]) {
            return errResult(
              `ref @${ref} 不存在或已过期（页面可能已导航），请重新 browser_snapshot 或 browser_screenshot {annotate:true}`,
              "invalid_ref",
            );
          }
          const loc = (await runViewOp(
            () => view.evaluate(resolveRefScript(ref)),
            OPERATION_TIMEOUT_MS,
            "click ref",
          )) as { found?: boolean; x?: number; y?: number } | undefined;
          if (
            !loc ||
            loc.found !== true ||
            typeof loc.x !== "number" ||
            typeof loc.y !== "number"
          ) {
            return errResult(
              `ref @${ref} 已过期：对应元素已不在当前页面，请重新 browser_snapshot 或 browser_screenshot {annotate:true}`,
              "invalid_ref",
            );
          }
          const rx = loc.x;
          const ry = loc.y;
          await runViewOp(
            () =>
              view.click(
                rx,
                ry,
                cleanOpts({
                  button: str(p.button),
                  modifiers: arr(p.modifiers),
                  clickCount: num(p.clickCount),
                }),
              ),
            OPERATION_TIMEOUT_MS,
            "click",
          );
          return opResult(state, { ok: true, action: "click", ref }, wantSnapshot);
        }
        // 文本定位：点那个写着某文本的可见交互元素（CSS selector 表达不了文本匹配，
        // 这是 POS/后台系统最高频的点击形态）。优先级 ref > text > selector > x/y。
        const clickText = str(p.text);
        if (clickText !== undefined) {
          if (!clickText.trim()) {
            return errResult("click 的 text 不能为空", "invalid_click_text");
          }
          const loc = (await runViewOp(
            () => view.evaluate(clickTextScript(clickText)),
            OPERATION_TIMEOUT_MS,
            "click text",
          )) as { found?: boolean; x?: number; y?: number; label?: string } | undefined;
          if (
            !loc ||
            loc.found !== true ||
            typeof loc.x !== "number" ||
            typeof loc.y !== "number"
          ) {
            return errResult(
              `未找到文本包含 "${clickText}" 的可见可交互元素；可先用 browser_snapshot 查看页面，或改用 selector/x-y`,
              "click_text_not_found",
            );
          }
          const tx = loc.x;
          const ty = loc.y;
          await runViewOp(
            () =>
              view.click(
                tx,
                ty,
                cleanOpts({
                  button: str(p.button),
                  modifiers: arr(p.modifiers),
                  clickCount: num(p.clickCount),
                }),
              ),
            OPERATION_TIMEOUT_MS,
            "click",
          );
          return opResult(
            state,
            { ok: true, action: "click", textMatch: loc.label ?? clickText },
            wantSnapshot,
          );
        }
        const selector = str(p.selector);
        if (selector) {
          // 模型常见幻觉参数：selector 传成字面 "null"/"undefined"——快速失败并指向
          // 文本定位/snapshot，不烧 30s 超时（实测：等待不可动作元素直到 timeout）
          if (selector === "null" || selector === "undefined" || !selector.trim()) {
            return errResult(
              `无效的 selector: "${selector}"。若你想按文本点击，请改传 text 参数（如 text:"按钮文本"）；或先用 browser_snapshot 获取元素 ref`,
              "invalid_click_selector",
            );
          }
          try {
            await runViewOp(
              () =>
                view.click(
                  selector,
                  cleanOpts({
                    button: str(p.button),
                    modifiers: arr(p.modifiers),
                    clickCount: num(p.clickCount),
                    timeout: num(p.timeout),
                  }),
                ),
              OPERATION_TIMEOUT_MS,
              "click",
            );
          } catch (err) {
            const msg = errMessage(err);
            // 超时未命中：给模型一条可操作的出路，而不是裸超时信息
            if (/timeout|actionable|waiting for/i.test(msg)) {
              return errResult(
                `click 超时：selector "${selector}" 未命中可交互元素。可改用 text:"…" 按文本定位，或 browser_snapshot 后按 ref 点击；当前页面 ${view.url}`,
                "invalid_click_selector",
              );
            }
            return errResult(
              `browser_evaluate click 失败: ${msg}；当前页面 ${view.url} (${view.title})`,
              msg,
            );
          }
        } else if (typeof p.x === "number" && typeof p.y === "number") {
          // 先收窄到 const，否则 typeof 收窄不会传播进闭包（p 是可变 Record）
          const x = p.x;
          const y = p.y;
          await runViewOp(
            () =>
              view.click(
                x,
                y,
                cleanOpts({
                  button: str(p.button),
                  modifiers: arr(p.modifiers),
                  clickCount: num(p.clickCount),
                }),
              ),
            OPERATION_TIMEOUT_MS,
            "click",
          );
        } else {
          return errResult(
            "action=click 需要 selector、x/y 或 ref",
            "missing_click_target",
          );
        }
        return opResult(state, { ok: true, action: "click" }, wantSnapshot);
      }
      case "type": {
        const text = str(p.text);
        if (!text)
          return errResult("action=type 需要 text 参数", "missing_text");
        const typeSelector = str(p.selector);
        if (typeSelector) {
          // 有 selector：click 聚焦 → 键入 → 验证 → 未生效自动原生 setter 兜底。
          // 背景：SPA 内页重渲染会吞焦点导致键入失效（第十二/十三轮实测），
          // 把「click 聚焦 + type + 验证 + eval 兑底」四步三次往返压成一次调用。
          try {
            await runViewOp(
              () => view.click(typeSelector, { timeout: num(p.timeout) ?? 5000 }),
              OPERATION_TIMEOUT_MS,
              "type 聚焦",
            );
          } catch {
            // 聚焦失败继续（元素可能已聚焦）
          }
          await runViewOp(() => view.type(text), OPERATION_TIMEOUT_MS, "type");
          const probe = `/* wa-typecheck */ (() => { const el = document.querySelector(${JSON.stringify(typeSelector)}); return el ? String(el.value ?? "") : ""; })()`;
          let check: unknown;
          try {
            check = await runViewOp(() => view.evaluate(probe), OPERATION_TIMEOUT_MS, "type 验证");
          } catch {
            check = undefined;
          }
          if (check === text) {
            return opResult(state, { ok: true, action: "type", selector: typeSelector }, wantSnapshot);
          }
          // 键入未生效（自绘组件/焦点被吞）：原生 setter + input/change 事件兑底
          const setScript = `/* wa-typeset */ (() => {
            const el = document.querySelector(${JSON.stringify(typeSelector)});
            if (!el) return "NO_EL";
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const set = Object.getOwnPropertyDescriptor(proto, "value").set;
            set.call(el, ${JSON.stringify(text)});
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return String(el.value ?? "");
          })()`;
          const fallbackVal = await runViewOp(
            () => view.evaluate(setScript),
            OPERATION_TIMEOUT_MS,
            "type 兑底",
          );
          return opResult(
            state,
            { ok: fallbackVal === text, action: "type", selector: typeSelector, fallback: true },
            wantSnapshot,
          );
        }
        await runViewOp(() => view.type(text), OPERATION_TIMEOUT_MS, "type");
        return opResult(state, { ok: true, action: "type" }, wantSnapshot);
      }
      case "press": {
        const key = str(p.key);
        if (!key) return errResult("action=press 需要 key 参数", "missing_key");
        await runViewOp(
          () => view.press(key, cleanOpts({ modifiers: arr(p.modifiers) })),
          OPERATION_TIMEOUT_MS,
          "press",
        );
        return opResult(state, { ok: true, action: "press" }, wantSnapshot);
      }
      case "scroll": {
        const dx = num(p.dx) ?? 0;
        const dy = num(p.dy) ?? 0;
        await runViewOp(
          () => view.scroll(dx, dy),
          OPERATION_TIMEOUT_MS,
          "scroll",
        );
        return opResult(state, { ok: true, action: "scroll" }, wantSnapshot);
      }
      case "scrollTo": {
        const selector = str(p.selector);
        if (!selector)
          return errResult(
            "action=scrollTo 需要 selector 参数",
            "missing_selector",
          );
        await runViewOp(
          () =>
            view.scrollTo(
              selector,
              cleanOpts({ block: str(p.block), timeout: num(p.timeout) }),
            ),
          OPERATION_TIMEOUT_MS,
          "scrollTo",
        );
        return opResult(state, { ok: true, action: "scrollTo" }, wantSnapshot);
      }
      default:
        return errResult(
          `未知 action: ${action}（可选 eval/click/type/press/scroll/scrollTo）`,
          "unknown_action",
        );
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
    return errResult(
      "浏览器视图未创建：请先调用 browser_navigate 打开页面",
      "no_view",
    );
  }
  const p = params as {
    format?: unknown;
    quality?: unknown;
    return?: unknown;
    annotate?: unknown;
  };
  const format = str(p.format) ?? "png";
  const quality = num(p.quality);
  const returnMode = str(p.return) ?? "path";
  try {
    // annotate：截图前注入编号标注并缓存 refs。明确要求标注时注入失败直接报错，
    // 不静默降级为普通截图（refs 缺失会让后续 click ref 全部失效，埋雷不如报错）。
    if (p.annotate === true) {
      const raw = await runViewOp(
        () => state.view.evaluate(ANNOTATE_SCRIPT),
        OPERATION_TIMEOUT_MS,
        "annotate",
      );
      if (!raw || typeof raw !== "object") {
        throw new Error("标注注入失败：页面未返回 refs 对象");
      }
      state.refs = raw as Record<string, ElementRef>;
    }
    if (returnMode === "base64") {
      const b64 = (await runViewOp(
        () => state.view.screenshot({ format, quality, encoding: "base64" }),
        OPERATION_TIMEOUT_MS,
        "screenshot",
      )) as string;
      const dataUrl = `data:image/${format === "jpeg" ? "jpeg" : format === "webp" ? "webp" : "png"};base64,${b64}`;
      const result = {
        ok: true,
        base64: dataUrl,
        url: state.view.url,
        title: state.view.title,
        refs: state.refs,
      };
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
    const result = {
      ok: true,
      path,
      url: state.view.url,
      title: state.view.title,
      format,
      sizeBytes: buf.length,
      refs: state.refs,
    };
    return textResult(JSON.stringify(result), result);
  } catch (err) {
    return errResult(`截图失败: ${errMessage(err)}`, errMessage(err));
  }
}

async function snapshotTool(
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
  try {
    // 稳定检测抓帧（双帧一致 + 非空门槛——导航后 SPA 首屏未挂载时空帧不算稳定；
    // 最多 4 帧），并刷新差值基准供后续操作对比
    const { refs, text, framesValid } = await captureStableSnapshot(state.view, {
      requireNonEmpty: true,
    });
    if (framesValid === 0) {
      throw new Error("快照失败：页面未返回 refs 对象");
    }
    const prev = state.lastSnapshot;
    state.refs = refs as Record<string, ElementRef>;
    state.lastSnapshot = text;
    const snapshot = text; // 显式调用给完整状态（不打星；星号仅操作流的附加快照用）
    const body =
      snapshot.length > EVAL_RESULT_MAX_CHARS
        ? snapshot.slice(0, EVAL_RESULT_MAX_CHARS) +
          `…（截断，原长 ${snapshot.length}）`
        : snapshot;
    const result = {
      ok: true,
      snapshot: body,
      url: state.view.url,
      title: state.view.title,
      refCount: Object.keys(refs).length,
      changed: prev !== undefined && prev !== text ? true : undefined,
    };
    return textResult(JSON.stringify(result), {
      ok: true,
      refCount: result.refCount,
    });
  } catch (err) {
    return errResult(`browser_snapshot 失败: ${errMessage(err)}`, errMessage(err));
  }
}

/**
 * 操作完成后附页面文本快照（差值+稳定检测，对齐 Playwright MCP「每步自动返快照」+
 * browser-use 的变化星号）：稳定检测（双帧一致，最多 4 帧/约 750ms，超时取末帧降级）后
 * 与上次快照对比——有变化：全量快照（新增/变化行打 "*"）；无变化：snapshotUnchanged；
 * 注入失败：snapshotError（操作本身已成功，绝不因附加信息失败而报错）。
 * 任一情况 refs 缓存都刷新为最新，click ref 即刻可用。
 */
async function attachAutoSnapshot(
  state: BrowserViewState,
  result: Record<string, unknown>,
  opts: { maxFrames?: number } = {},
): Promise<void> {
  try {
    const { refs, text } = await captureStableSnapshot(state.view, opts);
    state.refs = refs as Record<string, ElementRef>;
    result.refCount = Object.keys(refs).length;
    // 模态遮罩检测：文本快照对遮罩无感知（历史多轮卡点），操作后立即提示，
    // 避免 agent 盲目重试数轮才发现被弹窗挡住
    try {
      const modalText = await runViewOp(
        () => state.view.evaluate(MODAL_PROBE),
        OPERATION_TIMEOUT_MS,
        "modal 检测",
      );
      if (typeof modalText === "string" && modalText) result.modalDetected = modalText;
    } catch {
      // 检测失败忽略（快照与操作本身已成功）
    }
    if (text.length === 0) {
      // 稳定检测预算内页面始终没有可交互元素（SPA 首屏挂载中/真空白页）：
      // 不返回空快照误导 agent，也不污染差值基准，给明确提示让 agent 稍后重取
      result.snapshotNote =
        "页面尚未渲染出可交互元素（SPA 首屏挂载中或页面为空）；稍后可重新调用 browser_snapshot 获取";
      return;
    }
    if (text !== state.lastSnapshot) {
      result.snapshot = diffSnapshotLines(state.lastSnapshot, text);
      state.lastSnapshot = text;
    } else {
      result.snapshotUnchanged = true;
    }
  } catch (err) {
    result.snapshotError = errMessage(err);
  }
}

/** 操作类 action 的统一返回：按需附快照后序列化 */
async function opResult(
  state: BrowserViewState,
  base: Record<string, unknown>,
  wantSnapshot: boolean,
): Promise<BridgeToolResult> {
  if (wantSnapshot) await attachAutoSnapshot(state, base);
  return textResult(JSON.stringify(base), { ok: true });
}

/**
 * 读页面文本：无 selector 返回 body innerText，有 selector 返回该元素子树 innerText。
 * 超长截断（EVAL_RESULT_MAX_CHARS）并标 truncated；selector 未命中报 read_element_not_found。
 * 与 eval 的区别：结构化、免写脚本、统一截断语义，覆盖「读表格/读面板内容」高频需求。
 */
async function readTool(
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
  const p = params as { selector?: unknown };
  const selector = str(p.selector);
  const script = selector === undefined
    ? "/* wa-read */ document.body.innerText"
    : `/* wa-read */ (document.querySelector(${JSON.stringify(selector)})?.innerText ?? null)`;
  try {
    const raw = (await runViewOp(
      () => state.view.evaluate(script),
      OPERATION_TIMEOUT_MS,
      "read",
    )) as string | null | undefined;
    if (raw === null || raw === undefined) {
      return errResult(
        `未找到元素：${selector}；可先用 browser_snapshot 查看页面结构`,
        "read_element_not_found",
      );
    }
    const text = typeof raw === "string" ? raw : String(raw);
    const truncated = text.length > EVAL_RESULT_MAX_CHARS;
    const result = {
      ok: true,
      text: truncated ? text.slice(0, EVAL_RESULT_MAX_CHARS) + "…（截断）" : text,
      url: state.view.url,
      title: state.view.title,
      truncated: truncated ? true : undefined,
    };
    return textResult(JSON.stringify(result), { ok: true });
  } catch (err) {
    return errResult(`browser_read 失败: ${errMessage(err)}`, errMessage(err));
  }
}

/**
 * 条件等待：轮询页面直到条件满足或超时（默认 10s，轮询间隔 250ms）。
 * 条件（至少给一个，多个时全部满足才返回）：text 页面文本包含；hiddenSelector 元素
 * 从 DOM 移除或不可见；ms 无条件固定等待（上限 10s）。覆盖「点提交后等 toast/等列表
 * 刷新」高频场景，替代模型用 eval 自写 setTimeout 采样。
 */
async function waitTool(
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
  const p = params as {
    text?: unknown;
    ms?: unknown;
    hiddenSelector?: unknown;
    timeout?: unknown;
    hash?: unknown;
  };
  const wantText = str(p.text);
  const hiddenSel = str(p.hiddenSelector);
  const wantHash = str(p.hash);
  const ms = num(p.ms);
  if (
    wantText === undefined &&
    hiddenSel === undefined &&
    wantHash === undefined &&
    ms === undefined
  ) {
    return errResult(
      "browser_wait 至少需要一个条件：text / hiddenSelector / hash / ms",
      "wait_missing_condition",
    );
  }
  const t0 = Date.now();
  if (ms !== undefined && wantText === undefined && hiddenSel === undefined && wantHash === undefined) {
    await Bun.sleep(Math.min(ms, 10_000));
    return textResult(
      JSON.stringify({ ok: true, waitedMs: Date.now() - t0 }),
      { ok: true },
    );
  }
  const timeoutMs = Math.min(num(p.timeout) ?? 10_000, 60_000);
  const textProbe = wantText === undefined
    ? undefined
    : `/* wa-wait-text */ document.body.innerText.includes(${JSON.stringify(wantText)})`;
  const hiddenProbe = hiddenSel === undefined
    ? undefined
    : `/* wa-wait-hidden */ (() => { const el = document.querySelector(${JSON.stringify(hiddenSel)}); return !el || el.getBoundingClientRect().width === 0; })()`;
  const textScript = textProbe ?? "true";
  // text 与 hidden 条件并存时在轮询里分别探测，全部满足才算
  const hashProbe = wantHash === undefined
    ? undefined
    : `/* wa-wait-hash */ location.hash.includes(${JSON.stringify(wantHash)})`;
  while (Date.now() - t0 < timeoutMs) {
    try {
      let satisfied = true;
      if (textProbe) {
        const r = await runViewOp(
          () => state.view.evaluate(textScript),
          OPERATION_TIMEOUT_MS,
          "wait text",
        );
        if (r !== true) satisfied = false;
      }
      if (satisfied && hiddenProbe) {
        const r = await runViewOp(
          () => state.view.evaluate(hiddenProbe),
          OPERATION_TIMEOUT_MS,
          "wait hidden",
        );
        if (r !== true) satisfied = false;
      }
      if (satisfied && hashProbe) {
        const r = await runViewOp(
          () => state.view.evaluate(hashProbe),
          OPERATION_TIMEOUT_MS,
          "wait hash",
        );
        if (r !== true) satisfied = false;
      }
      if (satisfied) {
        return textResult(
          JSON.stringify({ ok: true, matched: true, waitedMs: Date.now() - t0 }),
          { ok: true },
        );
      }
    } catch {
      // 单次探测失败（页面跳转中/执行环境未就绪）不终止等待，下一轮重试
    }
    await Bun.sleep(250);
  }
  return errResult(
    `等待超时（${timeoutMs}ms）：${wantText !== undefined ? `页面文本未出现 "${wantText}"` : ""}${wantText !== undefined && (hiddenSel !== undefined || wantHash !== undefined) ? "；" : ""}${hiddenSel !== undefined ? `元素未消失 ${hiddenSel}` : ""}${hiddenSel !== undefined && wantHash !== undefined ? "；" : ""}${wantHash !== undefined ? `hash 未包含 "${wantHash}"（当前 ${state.view.url}）` : ""}`,
    "wait_timeout",
  );
}

async function closeTool(
  manager: BrowserManager,
  sessionId: string,
): Promise<BridgeToolResult> {
  const existed = manager.get(sessionId) !== undefined;
  manager.closeSession(sessionId);
  const result = { ok: true, closed: existed };
  return textResult(JSON.stringify(result), result);
}
