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
  WebViewLike,
} from "./browser-manager";
import {
  ANNOTATE_SCRIPT,
  SNAPSHOT_SCRIPT,
  captureStableSnapshot,
  clickTextScript,
  hoverLocateScript,
  diffSnapshotLines,
  formatSnapshot,
  occlusionProbeScript,
} from "./browser-annotate";
import { locateRefTarget, type AxRefEntry, type RefClickTarget } from "./dom/ax-snapshot";

const NAVIGATE_TIMEOUT_MS = 120_000;
const OPERATION_TIMEOUT_MS = 60_000;
const EVAL_RESULT_MAX_CHARS = 8_000;

/**
 * 返回体动态提示（双保险之二，随工具描述一起内建）：browser_navigate/snapshot/
 * screenshot 及操作后自动快照的返回体每次都带，持续引导模型走 ref 工作流，
 * 防「凭训练记忆猜 selector」回潮。一句为限，避免 token 膨胀。
 */
const REF_HINT =
  "提示：元素定位优先级 ref > text > selector > x/y（ref = 上方快照中的 [ref=N]）";

/**
 * 返回体 ref 提示注入（所有带 ref/快照的返回路径共用）：已有快照文本 → 拼在首行
 * （模型读快照第一眼即见）；无快照文本（snapshotUnchanged/snapshot:false/截图）→
 * 独立 hint 字段（等价形式）。
 */
function applyRefHint(result: Record<string, unknown>): void {
  if (typeof result.snapshot === "string" && result.snapshot.length > 0) {
    result.snapshot = `${REF_HINT}\n${result.snapshot}`;
  } else {
    result.hint = REF_HINT;
  }
}

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

/**
 * 幂等安装原生 dialog 自动应答器：Page.enable + 订阅 Page.javascriptDialogOpening。
 * 页面 alert/confirm/prompt 会阻塞主线程导致后续操作挂起直到超时，订阅事件后记录
 * dialog 消息并立即应答解除阻塞：alert/confirm/beforeunload → accept，prompt →
 * dismiss（对齐 browser-use popups_watchdog 语义）。记录的 dialog 在下次操作返回时
 * 以 dismissedDialog 字段带回（take 语义，见 takeDismissedDialog）。引擎不支持
 * cdp/addEventListener（fake/旧引擎）或 Page.enable 失败时静默跳过——增强能力不阻断导航。
 */
async function installDialogAutoResponder(state: BrowserViewState): Promise<void> {
  const view = state.view;
  if (state.dialogWatcherInstalled) return;
  if (typeof view.cdp !== "function" || typeof view.addEventListener !== "function") return;
  state.dialogWatcherInstalled = true; // 先标记再安装，防并发重复注册监听
  try {
    // 先注册监听再 Page.enable：Bun.WebView 对无监听器的事件在 JSON 解析前丢弃，
    // enable 后立即可能来事件（如导航触发 beforeunload），不能错过
    view.addEventListener("Page.javascriptDialogOpening", (e) => {
      const d = e.data as { type?: unknown; message?: unknown } | undefined;
      const type = typeof d?.type === "string" ? d.type : "unknown";
      const message = typeof d?.message === "string" ? d.message : "";
      state.dialog = { type, message };
      // 应答失败静默：dialog 已记录，下次操作返回仍会提示模型 snapshot 确认
      void view
        .cdp!("Page.handleJavaScriptDialog", { accept: type !== "prompt" })
        .catch(() => {});
    });
    await view.cdp("Page.enable");
  } catch {
    // Page.enable 失败（如 cdp 会话未建立）：保持标记避免反复重试，主流程不受影响
  }
}

/** 取走并清空最近一次自动应答的 dialog（take 语义，保证不重复上报） */
function takeDismissedDialog(state: BrowserViewState): { type: string; message: string } | undefined {
  const d = state.dialog;
  state.dialog = undefined;
  return d;
}

/**
 * 点击前遮挡校验：对目标中心点跑 occlusionProbeScript，命中非目标且非其祖先/语义
 * 关联 → 返回 click_occluded 错误（附遮挡元素摘要，让模型自己决策先 snapshot 看弹窗，
 * 不自动旁路不自动清除）；未遮挡/探针失败（宁放行不错杀）返回 null 继续点击。
 */
async function occlusionCheck(
  view: WebViewLike,
  probe: string,
  targetDesc: string,
): Promise<BridgeToolResult | null> {
  try {
    const occ = (await runViewOp(
      () => view.evaluate(probe),
      OPERATION_TIMEOUT_MS,
      "click 遮挡校验",
    )) as
      | { occluded?: boolean; occluder?: { tag?: unknown; cls?: unknown; text?: unknown } }
      | undefined;
    if (!occ || occ.occluded !== true) return null;
    const tag = typeof occ.occluder?.tag === "string" ? occ.occluder.tag : "?";
    const cls = typeof occ.occluder?.cls === "string" ? occ.occluder.cls : "";
    const occText = typeof occ.occluder?.text === "string" ? occ.occluder.text : "";
    return errResult(
      `点击目标 ${targetDesc} 被遮挡：中心点实际命中 <${tag}${cls ? ` class="${cls}"` : ""}>（文本："${occText}"）。页面可能有弹窗/遮罩，请先 browser_snapshot 查看页面状态再决策，勿盲目重试`,
      "click_occluded",
    );
  } catch {
    return null;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * ref 参数解析（click/type/press 共用）：快照显示 [ref=N]，容错模型传 "@N" 或 "N"
 * 字符串格式。undefined=未传；null=传了但非法；正整数=有效。
 */
function parseRefParam(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  const ref =
    typeof raw === "number" && Number.isInteger(raw)
      ? raw
      : typeof raw === "string"
        ? (() => {
            const m = raw.trim().match(/^@?(\d+)$/);
            return m ? Number(m[1]) : undefined;
          })()
        : undefined;
  if (ref === undefined || !Number.isInteger(ref) || ref < 1) return null;
  return ref;
}

/** ref 非法参数的统一错误（click/type/press 同文案） */
function invalidRefResult(raw: unknown): BridgeToolResult {
  return errResult(
    `ref 需为正整数或 "@N" 格式，收到 ${JSON.stringify(raw)}`,
    "invalid_ref",
  );
}

/**
 * ref 定位公共链路（click/type/press 共用）：selectorMap 查缓存 → locateRefTarget
 * （scrollIntoViewIfNeeded + getBoxModel quad 中心；失效按 role+name 回查）→ 遮挡
 * 校验。定位成功返回坐标；任一步失败返回可操作的错误结果（invalid_ref/click_occluded）。
 */
async function locateRefForAction(
  view: WebViewLike,
  state: BrowserViewState,
  ref: number,
  action: string,
): Promise<
  | { target: RefClickTarget; entry: AxRefEntry }
  | { error: BridgeToolResult }
> {
  if (typeof view.cdp !== "function") {
    // selectorMap 只在 AX 线（cdp 引擎）产生；无 cdp 时 ref 语义不存在
    return {
      error: errResult(
        `${action} ref 需要 CDP 引擎（快照 [ref=N] 由 AX 树线产生），请重新 browser_snapshot`,
        "invalid_ref",
      ),
    };
  }
  const entry = state.selectorMap?.[ref];
  if (!entry) {
    return {
      error: errResult(
        `ref ${ref} 不存在或已过期（页面可能已导航），请重新 browser_snapshot 后使用新 ref`,
        "invalid_ref",
      ),
    };
  }
  let target: RefClickTarget;
  try {
    target = await runViewOp(
      () =>
        locateRefTarget(
          view as WebViewLike & {
            cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
          },
          ref,
          entry,
        ),
      OPERATION_TIMEOUT_MS,
      `${action} ref 定位`,
    );
  } catch (err) {
    // 失效回查失败（歧义/找不到）：给模型可操作的出路，不烧到超时
    return { error: errResult(errMessage(err), "invalid_ref") };
  }
  // 回查命中新节点：更新 selectorMap，后续操作直接命中新 id
  if (target.recovered) {
    state.selectorMap = { ...state.selectorMap, [target.backendNodeId]: entry };
  }
  // 点击/聚焦前遮挡校验：ref 无 DOM 锚点可重查，传 quad 中心坐标 + 目标文本 + AX
  // role 做近似判断（详见 occlusionProbeScript）：被遮罩/弹窗盖住时报错让模型先
  // snapshot 决策；输入类目标命中表单控件时探针语义放行（防 AX name 在 wrapper 上
  // 的误报，如百度搜索框）
  const occluded = await occlusionCheck(
    view,
    occlusionProbeScript({
      x: target.x,
      y: target.y,
      targetText: entry.name === "" ? undefined : entry.name,
      role: entry.role,
    }),
    `ref ${ref}（${entry.role} "${entry.name}"）`,
  );
  if (occluded) return { error: occluded };
  return { target, entry };
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

/**
 * 清空当前焦点元素：input/textarea 用原生 setter 置空 + input/change 事件（React
 * 受控组件友好，与 type 键入兑底同一套路）；contenteditable 清 textContent + input
 * 事件。返回状态标记供调试（NO_EL/NOT_EDITABLE/CLEARED）。
 */
function clearActiveElementScript(): string {
  return `/* wa-clear */ (() => {
  const el = document.activeElement;
  if (!el) return "NO_EL";
  if (el.isContentEditable) {
    el.textContent = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "CLEARED";
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value").set;
    set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return "CLEARED";
  }
  return "NOT_EDITABLE";
})()`;
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
    // dialog 自动应答器（幂等）：prepareUserAgent 内已确保至少导航过一次
    // （about:blank），cdp 会话已建立，此时 Page.enable 才能成功
    await installDialogAutoResponder(state);
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
        applyRefHint(result);
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
    // 导航后页面更换，上一轮的快照 ref 与 annotate 标注全部失效，清空缓存
    state.refs = undefined;
    state.selectorMap = undefined;
    const result = {
      ok: true,
      sessionId,
      url: state.view.url,
      title: state.view.title,
      loading: state.view.loading,
      fresh: fresh ? true : undefined,
      dismissedDialog: takeDismissedDialog(state),
    };
    // 操作后自动附文本快照（差值+稳定检测；snapshot:false 跳过）。
    // 导航是「从零到有」的最大等待场景，SPA 首屏挂载实测可超 3s（美管家）——预算提到
    // 16 帧（~4s），对齐 dagu（5s）的业界上限量级；稳定即提前返回，快站不受影响。
    if (p.snapshot !== false)
      await attachAutoSnapshot(state, result, { maxFrames: 16 });
    applyRefHint(result);
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
      case "click": {
        // ref 定位（优先于 selector/x/y）：ref = backendDOMNodeId，来自最近一次
        // browser_snapshot 的 selectorMap 缓存，定位/回查/遮挡校验走公共链路
        // locateRefForAction（与 type/press 同一套，保持 ref 工作流行为一致）。
        // 格式容错：快照显示为 [ref=N]，模型常传 "@N" 或 "N"，与数字 N 等价解析
        const ref = parseRefParam(p.ref);
        if (ref === null) return invalidRefResult(p.ref);
        if (ref !== undefined) {
          const loc = await locateRefForAction(view, state, ref, "click");
          if ("error" in loc) return loc.error;
          await runViewOp(
            () =>
              view.click(
                loc.target.x,
                loc.target.y,
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
            { ok: true, action: "click", ref, recovered: loc.target.recovered || undefined },
            wantSnapshot,
          );
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
          // 点击前遮挡校验：text 定位无 selector 可重查，传中心坐标 + 目标文本做
          // 祖先链近似判断（详见 occlusionProbeScript）
          const occludedText = await occlusionCheck(
            view,
            occlusionProbeScript({ x: tx, y: ty, targetText: clickText }),
            `"${clickText}"`,
          );
          if (occludedText) return occludedText;
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
            // 点击前遮挡校验（selector 可重查目标元素，精确判断）：快速失败给出
            // 遮挡语义，替代引擎 30s actionable 超时（引擎自身也做 topmost 检查，
            // 但报的是超时而非遮挡原因）
            const occludedSel = await occlusionCheck(
              view,
              occlusionProbeScript({ targetSelector: selector }),
              `"${selector}"`,
            );
            if (occludedSel) return occludedSel;
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
        // clear:true：输入前先清空焦点元素（重填字段场景），默认 false 追加语义不变
        const clear = p.clear === true;
        // ref 聚焦链路（优先于 selector）：locateRefTarget 坐标聚焦 → clear → 键入 →
        // activeElement 验证 → 未生效原生 setter 兑底。ref 模式无 selector 锚点，
        // 验证与兑底都以 activeElement 为目标（点击聚焦后即目标元素）。
        const typeRef = parseRefParam(p.ref);
        if (typeRef === null) return invalidRefResult(p.ref);
        if (typeRef !== undefined) {
          const loc = await locateRefForAction(view, state, typeRef, "type");
          if ("error" in loc) return loc.error;
          const recovered = loc.target.recovered || undefined;
          try {
            await runViewOp(
              () => view.click(loc.target.x, loc.target.y),
              OPERATION_TIMEOUT_MS,
              "type ref 聚焦",
            );
          } catch {
            // 聚焦失败继续（元素可能已聚焦）
          }
          if (clear) {
            // 重填场景：聚焦后先清空再键入（input/textarea 原生 setter + input/change；
            // contenteditable 清 textContent，见 clearActiveElementScript）
            await runViewOp(
              () => view.evaluate(clearActiveElementScript()),
              OPERATION_TIMEOUT_MS,
              "type 清空",
            );
          }
          await runViewOp(() => view.type(text), OPERATION_TIMEOUT_MS, "type");
          // 验证：读 activeElement 值（无 selector 锚点，以当前焦点元素为准）
          const probe = `/* wa-typecheck */ (() => { const el = document.activeElement; return el ? String(el.value ?? "") : ""; })()`;
          let check: unknown;
          try {
            check = await runViewOp(() => view.evaluate(probe), OPERATION_TIMEOUT_MS, "type 验证");
          } catch {
            check = undefined;
          }
          if (check === text) {
            return opResult(
              state,
              { ok: true, action: "type", ref: typeRef, recovered },
              wantSnapshot,
            );
          }
          // 键入未生效（自绘组件/焦点被吞）：activeElement 原生 setter + input/change 兑底
          const setScript = `/* wa-typeset */ (() => {
            const el = document.activeElement;
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
            { ok: fallbackVal === text, action: "type", ref: typeRef, fallback: true, recovered },
            wantSnapshot,
          );
        }
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
          if (clear) {
            // 重填场景：聚焦后先清空再键入（input/textarea 原生 setter + input/change；
            // contenteditable 清 textContent，见 clearActiveElementScript）
            await runViewOp(
              () => view.evaluate(clearActiveElementScript()),
              OPERATION_TIMEOUT_MS,
              "type 清空",
            );
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
        if (clear) {
          await runViewOp(
            () => view.evaluate(clearActiveElementScript()),
            OPERATION_TIMEOUT_MS,
            "type 清空",
          );
        }
        await runViewOp(() => view.type(text), OPERATION_TIMEOUT_MS, "type");
        return opResult(state, { ok: true, action: "type" }, wantSnapshot);
      }
      case "press": {
        const key = str(p.key);
        if (!key) return errResult("action=press 需要 key 参数", "missing_key");
        // ref 聚焦链路（快照 [ref=N]）：先坐标聚焦目标再派发按键（按键直接到达目标
        // 元素，省去先 click 聚焦一步往返）；无 ref 则对当前焦点元素，语义不变
        const pressRef = parseRefParam(p.ref);
        if (pressRef === null) return invalidRefResult(p.ref);
        if (pressRef !== undefined) {
          const loc = await locateRefForAction(view, state, pressRef, "press");
          if ("error" in loc) return loc.error;
          try {
            await runViewOp(
              () => view.click(loc.target.x, loc.target.y),
              OPERATION_TIMEOUT_MS,
              "press ref 聚焦",
            );
          } catch {
            // 聚焦失败继续（元素可能已聚焦）
          }
          await runViewOp(
            () => view.press(key, cleanOpts({ modifiers: arr(p.modifiers) })),
            OPERATION_TIMEOUT_MS,
            "press",
          );
          return opResult(
            state,
            { ok: true, action: "press", ref: pressRef, recovered: loc.target.recovered || undefined },
            wantSnapshot,
          );
        }
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
        hint: REF_HINT,
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
      hint: REF_HINT,
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
    const { text, framesValid, selectorMap, lastError } = await captureStableSnapshot(state.view, {
      requireNonEmpty: true,
    });
    if (framesValid === 0) {
      throw new Error(lastError ?? "快照失败：页面未返回快照数据");
    }
    const prev = state.lastSnapshot;
    if (selectorMap) state.selectorMap = selectorMap;
    state.lastSnapshot = text;
    const snapshot = text; // 显式调用给完整状态（不打星；星号仅操作流的附加快照用）
    // 先截断再拼提示首行：提示永远完整可见，截断阈值语义不变
    const body0 =
      snapshot.length > EVAL_RESULT_MAX_CHARS
        ? snapshot.slice(0, EVAL_RESULT_MAX_CHARS) +
          `…（截断，原长 ${snapshot.length}）`
        : snapshot;
    const body = `${REF_HINT}\n${body0}`;
    const result = {
      ok: true,
      snapshot: body,
      url: state.view.url,
      title: state.view.title,
      refCount: Object.keys(selectorMap ?? {}).length,
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
    const { text, framesValid, selectorMap, lastError } = await captureStableSnapshot(state.view, opts);
    if (framesValid === 0 && lastError) {
      // 双线全部帧无效且是抛错型失败：操作本身已成功，不报错阻断，但给 snapshotError
      // 让模型知道快照缺失（旧版 evaluate 抛错同语义）；纯空页（无错误）走下方 snapshotNote
      result.snapshotError = lastError;
      return;
    }
    if (selectorMap) state.selectorMap = selectorMap;
    result.refCount = Object.keys(selectorMap ?? {}).length;
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
  // 返回体动态提示（含操作后快照）：有快照文本拼首行，否则独立 hint 字段
  // 本次操作期间捕获到原生 dialog（已自动应答解除阻塞）→ 附到返回体提示模型；
  // take 语义：取走即清空，不重复上报
  const dismissed = takeDismissedDialog(state);
  if (dismissed) base.dismissedDialog = dismissed;
  if (wantSnapshot) await attachAutoSnapshot(state, base);
  applyRefHint(base);
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
    // 固定等待完成也附快照（等待常用于等渲染/动画，模型直接拿到就绪后的页面）
    const result: Record<string, unknown> = { ok: true, waitedMs: Date.now() - t0 };
    await attachAutoSnapshot(state, result);
    applyRefHint(result);
    return textResult(JSON.stringify(result), { ok: true });
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
        // 命中即附快照（差值/unchanged 机制照旧）：省掉模型 wait 后再 snapshot 的一轮往返
        const result: Record<string, unknown> = { ok: true, matched: true, waitedMs: Date.now() - t0 };
        await attachAutoSnapshot(state, result);
        applyRefHint(result);
        return textResult(JSON.stringify(result), { ok: true, matched: true });
      }
    } catch {
      // 单次探测失败（页面跳转中/执行环境未就绪）不终止等待，下一轮重试
    }
    await Bun.sleep(250);
  }
  const timeoutMsg = `等待超时（${timeoutMs}ms）：${wantText !== undefined ? `页面文本未出现 "${wantText}"` : ""}${wantText !== undefined && (hiddenSel !== undefined || wantHash !== undefined) ? "；" : ""}${hiddenSel !== undefined ? `元素未消失 ${hiddenSel}` : ""}${hiddenSel !== undefined && wantHash !== undefined ? "；" : ""}${wantHash !== undefined ? `hash 未包含 "${wantHash}"（当前 ${state.view.url}）` : ""}`;
  // 超时附当前页面快照（复用 attachAutoSnapshot 差值机制）：让模型直接看到页面现状
  // 自查未等到的原因，不必再调一次 browser_snapshot
  const extra: Record<string, unknown> = {};
  await attachAutoSnapshot(state, extra);
  applyRefHint(extra);
  let snapInfo = "";
  if (typeof extra.snapshot === "string") snapInfo = `\n\n当前页面快照：\n${extra.snapshot}`;
  else if (extra.snapshotUnchanged === true) snapInfo = "\n\n当前页面快照与上次一致（snapshotUnchanged），可回看上次快照";
  else if (typeof extra.snapshotError === "string") snapInfo = `\n\n当前快照获取失败：${extra.snapshotError}`;
  else if (typeof extra.snapshotNote === "string") snapInfo = `\n\n${extra.snapshotNote}`;
  return errResult(`${timeoutMsg}${snapInfo}`, "wait_timeout");
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
