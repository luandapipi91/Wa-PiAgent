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
 * 生成「按 data-wa-ref 实时定位元素」的脚本：先 scrollIntoView 居中，
 * 返回 { found: true, x, y }（视口中心坐标）或 { found: false }（元素已不存在）。
 * n 非正整数或超上限时抛错（防御性校验：n 会被拼接进脚本，必须杜绝注入）。
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
