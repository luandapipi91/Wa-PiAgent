// browser-annotate.ts —— browser_* 带注释截图的页面注入脚本。
//
// ANNOTATE_SCRIPT：截图前注入，为主文档可见的可交互元素叠加编号标注
// （红框 + 角标），并返回 refs 映射供模型按编号交互（配合 evaluateTool
// 的 click ref）。resolveRefScript：点击前实时重查元素位置——先滚动到
// 视口中央再取中心坐标，页面重排/滚动后依然点得准。
//
// 约束：ANNOTATE_SCRIPT 字面量内禁止出现反引号与 ${（本文件外层用模板
// 字符串包裹，脚本内部一律用字符串拼接，避免转义事故，测试有断言钉住）。
//
// 已知限制（声明行为，非缺陷）：只枚举主文档可见元素，不穿透 iframe 与
// shadow DOM；上限 MAX_ANNOTATED_ELEMENTS 个，超出部分不标注。

/** 可交互元素标注上限（超出部分不标注，防止超长页面生成爆炸性 refs）。改动需同步下方脚本内的枚举上限（已用插值单源化） */
export const MAX_ANNOTATED_ELEMENTS = 200;

/** 交互语义 role 白名单：snapshot/annotate 枚举的非原生可交互元素（ARIA 交互角色） */
export const INTERACTIVE_ROLES = [
  "button",
  "link",
  "checkbox",
  "radio",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "switch",
  "combobox",
  "textbox",
  "search",
  "slider",
  "treeitem",
] as const;

/** 交互 role 对应的 CSS 属性选择器串（供脚本内 querySelectorAll 拼接） */
export const INTERACTIVE_ROLE_SELECTOR = INTERACTIVE_ROLES.map(
  (r) => `[role="${r}"]`,
).join(",");

/** 清除旧标注的选择器前缀，测试断言与脚本行为共用此标记 */
export const ANNOTATE_SCRIPT: string = `(() => {
  const MARK = 'data-wa-annotate', REF = 'data-wa-ref';
  document.querySelectorAll('[' + MARK + ']').forEach(e => e.remove());
  document.querySelectorAll('[' + REF + ']').forEach(e => e.removeAttribute(REF));
  const SEL = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[onclick]';
  const els = [];
  const all = document.querySelectorAll(SEL);
  for (let i = 0; i < all.length && els.length < ${MAX_ANNOTATED_ELEMENTS}; i++) {
    const el = all[i], r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none') els.push(el);
  }
  const refs = {};
  for (let i = 0; i < els.length; i++) {
    const n = i + 1, el = els[i], b = el.getBoundingClientRect();
    el.setAttribute(REF, String(n));
    let label = el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('name') || '';
    label = label.trim().replace(/\\s+/g, ' ').slice(0, 40);
    refs['@' + n] = { n: n, tag: el.tagName.toLowerCase(), label: label, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    const box = document.createElement('div');
    box.setAttribute(MARK, 'box');
    box.style.cssText = 'position:fixed;left:' + (b.left - 1) + 'px;top:' + (b.top - 1) + 'px;width:' + (b.width + 2) + 'px;height:' + (b.height + 2) + 'px;border:1.5px solid #e11d48;border-radius:3px;z-index:2147483646;pointer-events:none;';
    document.body.appendChild(box);
    const badge = document.createElement('div');
    badge.setAttribute(MARK, 'badge');
    badge.textContent = String(n);
    badge.style.cssText = 'position:fixed;left:' + (b.left - 1) + 'px;top:' + Math.max(0, b.top - 11) + 'px;background:#e11d48;color:#fff;font:bold 11px/15px ui-monospace,monospace;padding:0 4px;border-radius:3px;z-index:2147483647;pointer-events:none;';
    document.body.appendChild(badge);
  }
  return refs;
})()`;

/**
 * 文本快照注入脚本：枚举可交互元素并打 data-wa-ref 锚点（供 click ref 实时定位），
 * 返回增强 refs（含 role/value/checked/pointer 元数据），不注入任何视觉 overlay。
 * 与 ANNOTATE_SCRIPT 的区别：后者叠加红框+角标供截图看，本脚本纯文本快照路线。
 * 枚举范围比 ANNOTATE_SCRIPT 宽：额外包含 cursor:pointer 且带可读文本的非原生元素
 * （POS 列表项、自绘按钮等高频形态，对齐 agent-browser 的 clickable 标记）。
 */
export const SNAPSHOT_SCRIPT: string = `(() => {
  const REF = 'data-wa-ref';
  document.querySelectorAll('[' + REF + ']').forEach(e => e.removeAttribute(REF));
  const seen = new Set();
  const els = [];
  const push = (el) => {
    if (!el || seen.has(el) || els.length >= ${MAX_ANNOTATED_ELEMENTS}) return;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none') { seen.add(el); els.push(el); }
  };
  document.querySelectorAll('a,button,input,select,textarea,[onclick],${INTERACTIVE_ROLE_SELECTOR}').forEach(push);
  const all = document.querySelectorAll('body *');
  for (let i = 0; i < all.length && els.length < ${MAX_ANNOTATED_ELEMENTS}; i++) {
    const el = all[i];
    if (seen.has(el)) continue;
    try { if (getComputedStyle(el).cursor !== 'pointer') continue; } catch (e) { continue; }
    const named = el.getAttribute('aria-label') || el.title || (el.childNodes.length === 1 ? el.textContent : '') || '';
    if (!named.trim()) continue;
    push(el);
  }
  const refs = {};
  for (let i = 0; i < els.length; i++) {
    const n = i + 1, el = els[i], b = el.getBoundingClientRect();
    el.setAttribute(REF, String(n));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    let label = el.innerText || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || el.getAttribute('name') || '';
    label = String(label).trim().replace(/\s+/g, ' ').slice(0, 40);
    const isCheck = tag === 'input' && (type === 'checkbox' || type === 'radio');
    let value = undefined;
    if (tag === 'input' && !isCheck && type !== 'submit' && type !== 'button') {
      // 密码框：空显示空串、非空才打码——否则 type 前后快照无变化，agent 无法感知输入生效
      value = type === 'password'
        ? (el.value ? '••••••' : '')
        : String(el.value ?? '').slice(0, 40);
    }
    const native = ['a','button','input','select','textarea'].includes(tag);
    refs['@' + n] = {
      n: n,
      tag: tag,
      role: el.getAttribute('role') || undefined,
      inputType: type || undefined,
      label: label,
      value: value,
      checked: isCheck ? !!el.checked : undefined,
      pointer: !native && getComputedStyle(el).cursor === 'pointer' ? true : undefined,
      x: Math.round(b.left + b.width / 2),
      y: Math.round(b.top + b.height / 2)
    };
  }
  return refs;
})()`;

/** 快照 refs 单条目的展示形状（宽松于 ElementRef：额外携带 role/value/checked/pointer 元数据） */
export interface BrowserSnapshotRef {
  n: number;
  tag: string;
  role?: string;
  inputType?: string;
  label: string;
  value?: string;
  checked?: boolean;
  pointer?: boolean;
  x: number;
  y: number;
}

/** 稳定检测选项（单测注入小间隔/少帧数；生产默认 250ms × 4 帧 ≈ 总等待 750ms）。
 * requireNonEmpty：空快照帧不算稳定（导航后 SPA 首屏未挂载时连续空帧不应提前返回）；
 * 预算内始终为空则降级返回末帧。导航场景建议开启，局部操作流不建议（局部更新可能无快照行变化）。 */
export interface StableSnapshotOptions {
  intervalMs?: number;
  maxFrames?: number;
  requireNonEmpty?: boolean;
}

/**
 * 带渲染稳定检测的快照抓取：每帧注入 SNAPSHOT_SCRIPT，相邻两帧格式化文本一致即认为
 * 渲染已稳定并返回该帧；持续变化（动画/轮询）超过帧数预算则取末帧降级（不报错，
 * 与 nexus-browser 的 fallback 策略同型）。kernel 侧循环而非页面内 await：复用
 * runViewOp 的单槽重试语义，且帧序列可被 fake view 精确控制便于测试。
 */
export async function captureStableSnapshot(
  view: { evaluate(script: string): Promise<unknown> },
  opts: StableSnapshotOptions = {},
): Promise<{
  refs: Record<string, BrowserSnapshotRef>;
  text: string;
  framesValid: number;
}> {
  const intervalMs = opts.intervalMs ?? 250;
  const maxFrames = opts.maxFrames ?? 4;
  let prevText: string | null = null;
  let last: {
    refs: Record<string, BrowserSnapshotRef>;
    text: string;
  } | undefined;
  let framesValid = 0;
  for (let frame = 0; frame < maxFrames; frame++) {
    if (frame > 0) await Bun.sleep(intervalMs);
    const raw = await view.evaluate(SNAPSHOT_SCRIPT);
    const refs = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      BrowserSnapshotRef
    >;
    if (raw && typeof raw === "object") framesValid++;
    const text = formatSnapshot(refs);
    const settled =
      prevText !== null &&
      text === prevText &&
      !(opts.requireNonEmpty && text.length === 0);
    if (settled) return { refs, text, framesValid };
    prevText = text;
    last = { refs, text };
  }
  return { ...last!, framesValid };
}

/**
 * 差值标记：与上次快照文本逐行对比，新出现（或值变化导致文本不同）的行打 "* " 前缀
 * （browser-use 同款变化高亮）；无基准（首次）或完全一致时原样返回（一致时外层应走
 * snapshotUnchanged 分支）。
 */
export function diffSnapshotLines(
  prev: string | undefined,
  next: string,
): string {
  if (prev === undefined) return next;
  const prevLines = new Set(prev.split("\n"));
  return next
    .split("\n")
    .map((line) => (prevLines.has(line) ? line : `* ${line}`))
    .join("\n");
}

/**
 * 把快照 refs 格式化为 agent-browser 风格的文本行（一行一个元素），供模型直接阅读定位：
 * @2 button "登 录" / @1 textbox "手机号" = "132" / @3 checkbox "同意协议" [checked] / @4 generic "深圳1测试店" (pointer)
 */
export function formatSnapshot(refs: Record<string, BrowserSnapshotRef>): string {
  return Object.entries(refs)
    .map(([key, r]) => {
      const kind = kindOf(r);
      const label = r.label ? ` "${r.label}"` : "";
      const value = r.value !== undefined ? ` = "${r.value}"` : "";
      const checked = r.checked ? " [checked]" : "";
      const pointer = r.pointer ? " (pointer)" : "";
      return `${key} ${kind}${label}${value}${checked}${pointer}`;
    })
    .join("\n");
}

/** 元素展示类型：优先 ARIA role，其次按原生标签/input type 归类 */
function kindOf(r: BrowserSnapshotRef): string {
  if (r.role) return r.role;
  if (r.tag === "input") {
    if (r.inputType === "checkbox" || r.inputType === "radio" || r.inputType === "search" || r.inputType === "file" || r.inputType === "range") {
      return r.inputType;
    }
    if (r.inputType === "submit" || r.inputType === "button") return "button";
    return "textbox";
  }
  if (r.tag === "a") return "link";
  if (r.tag === "button") return "button";
  if (r.tag === "select") return "combobox";
  if (r.tag === "textarea") return "textbox";
  return "generic";
}

/**
 * 生成「按可见文本定位并返回中心坐标」的悬停定位脚本：selector 优先（精确），否则按
 * 文本子串在可交互元素+自绘 pointer 元素里反向遍历取**最深**匹配。scrollIntoView 居中后
 * 返回 { found:true, x, y, label } 或 { found:false }。文本经 JSON.stringify 转义防注入。
 * 首行 wa-hover 标记供测试/fake 识别（hover 动作用：定位后经 CDP 真实鼠标移动触发悬停）。
 */
export function hoverLocateScript(opts: {
  selector?: string;
  text?: string;
}): string {
  const sel = opts.selector ? JSON.stringify(opts.selector) : "null";
  const q = JSON.stringify(opts.text ?? "");
  return `/* wa-hover */ (() => {
  const sel = ${sel}, q = ${q};
  let el = null;
  if (sel) {
    el = document.querySelector(sel);
  } else {
    const SEL = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[onclick],[class*="tab"],[class*="menu"],[class*="dropdown"]';
    const els = [...document.querySelectorAll(SEL)];
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      const t = String(e.innerText || e.getAttribute('aria-label') || e.title || '');
      if (t.includes(q)) { el = e; break; }
    }
    if (!el) {
      const all = [...document.querySelectorAll('body *')];
      for (let i = all.length - 1; i >= 0; i--) {
        const e = all[i];
        if (getComputedStyle(e).cursor !== 'pointer') continue;
        const t = String(e.innerText || e.getAttribute('aria-label') || e.title || '');
        if (t.includes(q) && t.length < 60) { el = e; break; }
      }
    }
  }
  if (!el) return { found: false };
  const r = el.getBoundingClientRect(), s = getComputedStyle(el);
  if (r.width <= 0 || r.height <= 0 || s.visibility === 'hidden' || s.display === 'none') return { found: false };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const b = el.getBoundingClientRect();
  let label = String(el.innerText || el.getAttribute('aria-label') || el.title || '');
  label = label.trim().replace(/\\s+/g, ' ').slice(0, 40);
  return { found: true, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), label: label };
})()`;
}

/**
 * 生成「按可见文本定位并返回中心坐标」的脚本：在可交互元素（含交互 role/onclick）里
 * 反向遍历取**最深**的文本匹配（避免命中包含同文本的父容器），scrollIntoView 居中后
 * 返回 { found:true, x, y, label } 或 { found:false }。目标文本经 JSON.stringify 转义嵌入，
 * 杜绝脚本注入。脚本首行带 wa-click-text 标记供测试/fake 识别。
 */
export function clickTextScript(text: string): string {
  return `/* wa-click-text */ (() => {
  const q = ${JSON.stringify(text)};
  // 结构性交互元素 + class 启发式（menu/tab/dropdown/btn，覆盖 ant 等自绘组件）——
  // 与 hoverLocateScript 保持同一集合，避免「hover 能悬停的 click 找不到」
  const SEL = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[onclick],[class*="menu"],[class*="tab"],[class*="dropdown"],[class*="btn"],[class*="button"]';
  const els = [...document.querySelectorAll(SEL)];
  // 全半角括号归一化：产品名含全角括号、模型查询常用半角，归一后才匹配（第四轮实测）
  const normalize = (s) => String(s).replace(/（/g, '(').replace(/）/g, ')');
  const visible = (el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const drillDown = (el) => {
    // 容器命中（class 含 menu/tab 但自身是导航条外壳）时向下钻到仍包含目标的
    // 最深可见后代，避免点到容器中心落空（实测导航条 textMatch 整行）
    let cur = el;
    for (;;) {
      const kids = [...cur.children].filter(visible);
      const deeper = kids.find((k) => normalize(String(k.innerText || '')).includes(normalize(q)));
      if (!deeper) return cur;
      cur = deeper;
    }
  };
  const tryHit = (el0) => {
    const t0 = normalize(String(el0.innerText || el0.value || el0.getAttribute('aria-label') || el0.title || ''));
    if (!t0.includes(normalize(q)) || !visible(el0)) return null;
    const el = drillDown(el0);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const b = el.getBoundingClientRect();
    const label = String(el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    return { found: true, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), label: label };
  };
  // 第一轮：结构性交互元素 + class 启发式集合
  for (let i = els.length - 1; i >= 0; i--) {
    const hit = tryHit(els[i]);
    if (hit) return hit;
  }
  // 第二轮兜底：全 DOM 反向最深匹配（覆盖分类树等不在启发式集合的自绘节点）
  const all = [...document.querySelectorAll('body *')];
  for (let i = all.length - 1; i >= 0; i--) {
    const hit = tryHit(all[i]);
    if (hit) return hit;
  }
  return { found: false };
})()`;
}

/**
 * 生成「按 data-wa-ref 实时定位元素」的脚本：先 scrollIntoView 居中（水平垂直都居中，
 * 超宽元素中心才不会落在视口外），返回 { found: true, x, y }（视口中心坐标）或
 * { found: false }（元素已不存在）。n 非正整数或超上限时抛错（防御性校验：n 会被
 * 拼接进脚本，必须杜绝注入）。
 */
export function resolveRefScript(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_ANNOTATED_ELEMENTS) {
    throw new Error(`ref 必须是 1-${MAX_ANNOTATED_ELEMENTS} 的整数，收到 ${n}`);
  }
  return `(() => {
    const el = document.querySelector('[data-wa-ref="${n}"]');
    if (!el) return { found: false };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;
}

/** occlusionProbeScript 的入参：三种目标描述至少给一种（优先 selector > ref > text） */
export interface OcclusionProbeOpts {
  /** text 定位模式的中心点坐标（text 无 selector 可重查，必须外部传坐标） */
  x?: number;
  y?: number;
  /** selector 定位模式：脚本内重查并取 rect 中心做 elementFromPoint */
  targetSelector?: string;
  /** ref 定位模式：重查 [data-wa-ref="N"] */
  targetRef?: number;
  /** text 定位模式的目标文本（祖先链文本近似判断） */
  targetText?: string;
}

/**
 * 生成「点击前遮挡校验」脚本：对目标中心点 document.elementFromPoint，命中非目标且
 * 非其祖先/语义关联（label↔input）→ 返回 { occluded:true, occluder:{tag,cls,text} }；
 * 否则 { occluded:false }。宁放行不错杀：目标重查不到（已过期，由后续定位逻辑报错）、
 * 中心点无命中（坐标在视口外，点击逻辑自己处理）均放行。三种判断策略：
 * - selector/ref：重查目标元素精确判断（contains 双向 + label↔表单控件关联）
 * - text：目标无 selector 可重查，三重判断——hit 自身文本含目标 / hit 后代文本含
 *   目标（hit 是容器）/ hit 是表单控件且 value、aria-label 或关联 label 文本含目标；
 *   均不满足 → 遮挡（真实遮罩场景 hit 无关，其后代必不含目标文本）
 * 入参全部经 JSON.stringify/整数校验转义嵌入，杜绝脚本注入。脚本首行带 wa-occlusion
 * 标记供测试/fake 识别。
 */
export function occlusionProbeScript(opts: OcclusionProbeOpts): string {
  const px = typeof opts.x === "number" && Number.isFinite(opts.x) ? Math.round(opts.x) : null;
  const py = typeof opts.y === "number" && Number.isFinite(opts.y) ? Math.round(opts.y) : null;
  const sel = opts.targetSelector !== undefined ? JSON.stringify(opts.targetSelector) : "null";
  if (opts.targetRef !== undefined) {
    const n = opts.targetRef;
    if (!Number.isInteger(n) || n < 1 || n > MAX_ANNOTATED_ELEMENTS) {
      throw new Error(`occlusion targetRef 必须是 1-${MAX_ANNOTATED_ELEMENTS} 的整数，收到 ${n}`);
    }
  }
  const ref = opts.targetRef !== undefined ? String(opts.targetRef) : "null";
  const text = opts.targetText !== undefined ? JSON.stringify(opts.targetText) : "null";
  return `/* wa-occlusion */ (() => {
  const SEL = ${sel};
  const REF = ${ref};
  const TEXT = ${text};
  const PX = ${px === null ? "null" : String(px)};
  const PY = ${py === null ? "null" : String(py)};
  const norm = (s) => String(s == null ? '' : s).replace(/（/g, '(').replace(/）/g, ')');
  const target = SEL ? document.querySelector(SEL) : (REF != null ? document.querySelector('[data-wa-ref="' + REF + '"]') : null);
  let px = PX, py = PY;
  if (target) {
    const r = target.getBoundingClientRect();
    px = Math.round(r.left + r.width / 2);
    py = Math.round(r.top + r.height / 2);
  }
  if (px == null || py == null) return { occluded: false };
  let hit = null;
  try { hit = document.elementFromPoint(px, py); } catch (e) { hit = null; }
  if (!hit) return { occluded: false };
  const related = (a, b) => {
    if (!a || !b) return false;
    if (a === b || a.contains(b) || b.contains(a)) return true;
    const tn = (el) => (el && el.tagName ? String(el.tagName).toUpperCase() : '');
    const lbl = tn(a) === 'LABEL' ? a : (tn(b) === 'LABEL' ? b : null);
    const ctl = ['INPUT','TEXTAREA','SELECT'].indexOf(tn(a)) >= 0 ? a : (['INPUT','TEXTAREA','SELECT'].indexOf(tn(b)) >= 0 ? b : null);
    if (lbl && ctl) {
      if (lbl.htmlFor && lbl.htmlFor === ctl.id) return true;
      if (lbl.contains(ctl)) return true;
      try { if (ctl.labels && Array.prototype.includes.call(ctl.labels, lbl)) return true; } catch (e) {}
    }
    return false;
  };
  if (target) {
    if (related(hit, target)) return { occluded: false };
  } else if (TEXT != null) {
    // text 定位：目标无 selector 可重查。祖先链近似不可行（遮罩向上链到 body，
    // body.innerText 必含目标文本，无法区分真祖先与共同祖先），改用三重判断：
    // 1) hit 自身文本含目标 → hit 即目标；2) hit 后代文本含目标 → hit 是目标容器；
    // 3) hit 是表单控件 → value/aria-label 或关联 label 文本含目标（label↔input）。
    // 文本源与 clickTextScript 的 tryHit 一致（innerText/value/aria-label/title），
    // 归一化同源（全角括号）。宁报遮挡不误放行：罕见结构误报时模型 snapshot 自查，
    // 代价远小于点在遮罩上的意外副作用。
    const q = norm(TEXT);
    const txt = (el) => norm(el.innerText || el.value || el.getAttribute('aria-label') || el.title || '');
    if (txt(hit).includes(q)) return { occluded: false };
    const kids = hit.querySelectorAll ? Array.prototype.slice.call(hit.querySelectorAll('*'), 0, 200) : [];
    for (let i = 0; i < kids.length; i++) {
      if (txt(kids[i]).includes(q)) return { occluded: false };
    }
    const tn = hit.tagName ? String(hit.tagName).toUpperCase() : '';
    if (tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT') {
      let lbl = null;
      try {
        if (hit.labels && hit.labels.length) lbl = hit.labels[0];
        else if (hit.id) lbl = document.querySelector('label[for="' + hit.id + '"]');
        else lbl = hit.closest('label');
      } catch (e) { lbl = null; }
      if (lbl && txt(lbl).includes(q)) return { occluded: false };
    }
  } else {
    return { occluded: false };
  }
  const rawCls = hit.className;
  const cls = typeof rawCls === 'string' ? rawCls : (rawCls && rawCls.baseVal) || '';
  return {
    occluded: true,
    occluder: {
      tag: String(hit.tagName || '').toLowerCase(),
      cls: String(cls).slice(0, 60),
      text: String(hit.innerText || hit.value || '').trim().replace(/\\s+/g, ' ').slice(0, 20),
    },
  };
})()`;
}
