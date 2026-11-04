// dom/ax-snapshot.ts —— AX 树形快照（对齐 agent-browser snapshot.rs 的形态）。
//
// 链路：Page.getFrameTree 拿 UUID frameId → Accessibility.getFullAXTree 拉 AX 节点
// → childIds 重建树 → ignored 节点折叠 → 连续 StaticText 聚合/去重 → 角色分类
// → 树形缩进渲染（`- role "name" [ref=N]`，ref = backendDOMNodeId）。
// 已验证经验：getFullAXTree 的 frameId 必须是 UUID（Page.getFrameTree 的 frame.id），
// 数字 frameId 报 Invalid parameters。

/** CDP AXValue（Accessibility.AXNode 的 role/name/value/properties[].value 值包裹） */
export interface AXValue {
  type?: string;
  value?: string | number | boolean;
}

/** CDP AXNode 子集（Accessibility.getFullAXTree 返回） */
export interface AXNode {
  nodeId: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  frameId?: string;
}

/** INTERACTIVE 角色：无条件分配 ref（agent-browser INTERACTIVE_ROLES + TABLE_CELL_ROLES） */
const AX_INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox", "listbox",
  "menuitem", "menuitemcheckbox", "menuitemradio", "option", "searchbox",
  "slider", "spinbutton", "switch", "tab", "treeitem", "Iframe",
  "cell", "gridcell", "columnheader", "rowheader",
]);

/** CONTENT 角色：有可访问名才分配 ref */
const AX_CONTENT_ROLES: ReadonlySet<string> = new Set([
  "heading", "listitem", "article", "region", "main", "navigation",
]);

/** 角色分类结果：text 为 StaticText（文本内容行，无 ref） */
export type AxRoleClass = "interactive" | "content" | "structural" | "text";

/** AX 树节点（重建后；placeholder/dropped 为渲染期跳过标记） */
export interface AxTreeNode {
  role: string;
  name: string;
  /** value 字段存在才有此属性（空串也是有效值，如未输入的 textbox） */
  value?: string;
  /** properties.checked（"true"/"false"/"mixed"） */
  checked?: string;
  backendDOMNodeId?: number;
  roleClass: AxRoleClass;
  children: AxTreeNode[];
  /** ignored/InlineTextBox 占位：渲染时跳过自身、提升 children */
  placeholder: boolean;
  /** 聚合/同名去重后废弃：渲染时跳过 */
  dropped: boolean;
  /** cursor:pointer 兜底命中标记（渲染追加 (pointer)，structural 也强制 ref） */
  pointer?: boolean;
  /** ref 分配标记（assignAxRefs 后置位） */
  hasRef?: boolean;
}

/** click 回查缓存条目：ref(backendDOMNodeId) → {role,name} */
export interface AxRefEntry {
  role: string;
  name: string;
}

/** AX 树：roots 通常 1 个（RootWebArea）；allBackendIds 供兜底去重 */
export interface AxTree {
  roots: AxTreeNode[];
  allBackendIds: Set<number>;
}

/**
 * 角色分类：INTERACTIVE 无条件 ref / CONTENT 有名才 ref / STRUCTURAL 不 ref 不剪枝
 * 仅遍历 / StaticText 文本内容行。未知角色安全缺省为 structural（遍历不丢子树）。
 */
export function classifyAxRole(role: string): AxRoleClass {
  if (role === "StaticText") return "text";
  if (AX_INTERACTIVE_ROLES.has(role)) return "interactive";
  if (AX_CONTENT_ROLES.has(role)) return "content";
  return "structural";
}

/** 角色归一：IframePresentational 与 Iframe 同语义（同 iframe 的 ref 与回查一致） */
export function normalizeAxRole(role: string): string {
  return role === "IframePresentational" ? "Iframe" : role;
}

/** AXValue → 展示字符串（string 原样，number/bool 序列化，缺省空串） */
export function extractAxString(value: AXValue | undefined): string {
  const v = value?.value;
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  return String(v);
}

/**
 * AX 节点数组 → 树（对齐 agent-browser build_tree）。
 * ① childIds 重建父子 ② ignored（非根）/InlineTextBox 转占位（渲染时提升 children）
 * ③ 连续 StaticText 聚合到首个 ④ 单 StaticText 与父同名去重废弃 ⑤ 收集 allBackendIds。
 */
export function buildAxTree(nodes: AXNode[]): AxTree {
  const treeNodes: AxTreeNode[] = nodes.map((node) => {
    const role = normalizeAxRole(extractAxString(node.role));
    const ignoredSkip =
      (node.ignored === true && role !== "RootWebArea") || role === "InlineTextBox";
    const checked = node.properties?.find((p) => p.name === "checked");
    return {
      role: ignoredSkip ? "" : role,
      name: ignoredSkip ? "" : extractAxString(node.name),
      value: !ignoredSkip && node.value !== undefined ? extractAxString(node.value) : undefined,
      checked: checked !== undefined ? extractAxString(checked.value) : undefined,
      backendDOMNodeId: node.backendDOMNodeId,
      roleClass: ignoredSkip ? "structural" : classifyAxRole(role),
      children: [],
      placeholder: ignoredSkip,
      dropped: false,
    };
  });

  // childIds 重建父子（nodeId → 数组下标）
  const idToIdx = new Map<string, number>();
  nodes.forEach((node, i) => idToIdx.set(node.nodeId, i));
  nodes.forEach((node, i) => {
    for (const cid of node.childIds ?? []) {
      const ci = idToIdx.get(cid);
      if (ci !== undefined) treeNodes[i].children.push(treeNodes[ci]);
    }
  });

  // StaticText 聚合与同名去重（对齐 build_tree 的 aggregation/dedup）
  for (const parent of treeNodes) {
    if (parent.placeholder || parent.children.length === 0) continue;
    const kids = parent.children;
    let start = 0;
    while (start < kids.length) {
      if (kids[start].role !== "StaticText") {
        start++;
        continue;
      }
      let end = start + 1;
      while (end < kids.length && kids[end].role === "StaticText") end++;
      if (end > start + 1) {
        // 连续 StaticText 是 HTML 结构产物（内联标签拆分）非语义拆分，聚合到首个
        kids[start].name = kids
          .slice(start, end)
          .map((k) => k.name)
          .join("");
        for (let j = start + 1; j < end; j++) kids[j].dropped = true;
      }
      start = end;
    }
    // 唯一子 StaticText 与父同名 → 冗余文本行，废弃
    if (
      kids.length === 1 &&
      kids[0].role === "StaticText" &&
      parent.name === kids[0].name
    ) {
      kids[0].dropped = true;
    }
  }

  // 根 = 从未被挂为子节点的（childIds 断链的孤儿也算根）
  const isChild = new Set<AxTreeNode>();
  for (const node of treeNodes) for (const c of node.children) isChild.add(c);
  const roots = treeNodes.filter((n) => !isChild.has(n)).map(promote);

  function promote(node: AxTreeNode): AxTreeNode {
    node.children = expandChildren(node.children);
    for (const c of node.children) promote(c);
    return node;
  }

  /** 占位节点（ignored/InlineTextBox）展开提升，dropped（聚合后继/同名冗余）移除 */
  function expandChildren(children: AxTreeNode[]): AxTreeNode[] {
    const out: AxTreeNode[] = [];
    for (const c of children) {
      if (c.placeholder) out.push(...expandChildren(c.children));
      else if (!c.dropped) out.push(c);
    }
    return out;
  }

  const allBackendIds = new Set<number>();
  const visit = (node: AxTreeNode): void => {
    if (node.backendDOMNodeId !== undefined) allBackendIds.add(node.backendDOMNodeId);
    for (const c of node.children) visit(c);
  };
  for (const root of roots) visit(root);

  return { roots, allBackendIds };
}

/**
 * ref 分配 + selectorMap 构建（对齐 agent-browser should_ref 逻辑）：INTERACTIVE
 * 无条件 ref / CONTENT 有可访问名才 ref / STRUCTURAL 不 ref 仅遍历。ref 编号 =
 * backendDOMNodeId（跨快照相对稳定）。返回供 click 回查的 {ref → {role,name}} 缓存。
 */
export function assignAxRefs(tree: AxTree): Record<number, AxRefEntry> {
  const map: Record<number, AxRefEntry> = {};
  const visit = (node: AxTreeNode): void => {
    const shouldRef =
      node.roleClass === "interactive" ||
      (node.roleClass === "content" && node.name !== "");
    if (shouldRef && node.backendDOMNodeId !== undefined) {
      node.hasRef = true;
      map[node.backendDOMNodeId] = { role: node.role, name: node.name };
    }
    for (const child of node.children) visit(child);
  };
  for (const root of tree.roots) visit(root);
  return map;
}

/**
 * 树形缩进渲染（对齐 render_tree + 快照格式约定）：
 * `- {role} "{name}" = "{value}" [checked] [ref=N] (pointer)`，2 空格层级缩进。
 * 折叠：根包装（RootWebArea/WebArea）不出现；generic 无 ref 且单子 → 提升子层；
 * 空名 StaticText 跳过。StaticText 展示为 text（文本内容行）。name/value 经
 * JSON.stringify 转义；value 存在且 ≠ name 才显示（textbox 空串也显示）。
 * 内部先执行 ref 分配（幂等）；selectorMap 需另行调 assignAxRefs 获取。
 */
export function renderAxTree(tree: AxTree): string {
  assignAxRefs(tree);
  const out: string[] = [];  const walk = (node: AxTreeNode, indent: number): void => {
    // 根包装不产出行，children 从顶层开始
    if (node.role === "RootWebArea" || node.role === "WebArea") {
      for (const child of node.children) walk(child, indent);
      return;
    }
    // generic 无 ref 且单子：结构噪音，折叠提升
    if (node.role === "generic" && !node.hasRef && node.children.length <= 1) {
      for (const child of node.children) walk(child, indent);
      return;
    }
    // 空白 StaticText 不产噪音行
    if (node.role === "StaticText" && node.name.trim() === "") return;

    let line = `${"  ".repeat(indent)}- ${node.role === "StaticText" ? "text" : node.role}`;
    if (node.name !== "") line += ` ${JSON.stringify(node.name)}`;
    // 输入类角色（textbox/searchbox/combobox/spinbutton）始终显示当前值（无 value
    // 字段视为空串）——空值语义在差值对比中稳定可见（输入前后行文本变化）
    const isEditable =
      node.role === "textbox" || node.role === "searchbox" ||
      node.role === "combobox" || node.role === "spinbutton";
    const value = isEditable && node.value === undefined ? "" : node.value;
    if (value !== undefined && value !== node.name) {
      line += ` = ${JSON.stringify(value)}`;
    }
    if (node.checked === "true") line += " [checked]";
    else if (node.checked === "mixed") line += " [checked=mixed]";
    if (node.hasRef && node.backendDOMNodeId !== undefined) {
      line += ` [ref=${node.backendDOMNodeId}]`;
    }
    if (node.pointer) line += " (pointer)";
    out.push(line);
    for (const child of node.children) walk(child, indent + 1);
  };
  for (const root of tree.roots) walk(root, 0);
  return out.join("\n");
}

/** 兜底扫描元素（POINTER_PROBE_SCRIPT 产物 + CDP 解析的 backendNodeId） */
export interface PointerElement {
  backendId: number;
  text: string;
}

/** 按 backendDOMNodeId 递归找节点（兜底命中判定） */
function findByBackendId(roots: AxTreeNode[], backendId: number): AxTreeNode | undefined {
  for (const root of roots) {
    if (root.backendDOMNodeId === backendId) return root;
    const found = findByBackendId(root.children, backendId);
    if (found) return found;
  }
  return undefined;
}

/**
 * cursor:pointer 兑底合并：AX 树会漏自绘件（美管家 @6-@12 形态），扫描结果并入树形
 * 输出——backendId 命中 AX 节点 → 标 (pointer) 并强制 ref（structural 也给 ref，
 * 对齐 agent-browser 的 cursor-interactive should_ref）；未命中 → 附加行（标 ref 与
 * (pointer)）。同元素不重复出现由命中分支保证。selectorMap 同步增补。
 */
export function mergePointerElements(
  tree: AxTree,
  pointers: PointerElement[],
  refMap: Record<number, AxRefEntry>,
): { extraText: string } {
  const extraLines: string[] = [];
  for (const p of pointers) {
    const node = findByBackendId(tree.roots, p.backendId);
    if (node) {
      node.pointer = true;
      if (!node.hasRef) {
        node.hasRef = true;
        refMap[p.backendId] = { role: node.role, name: node.name };
      }
    } else {
      extraLines.push(`- generic ${JSON.stringify(p.text)} [ref=${p.backendId}] (pointer)`);
      refMap[p.backendId] = { role: "generic", name: p.text };
    }
  }
  return { extraText: extraLines.join("\n") };
}

/** 兑底扫描元素上限（与 MAX_ANNOTATED_ELEMENTS 同值不同源：两模块互不依赖） */
export const POINTER_PROBE_MAX = 200;
/**
 * cursor:pointer 兑底扫描脚本（对齐 agent-browser find_cursor_interactive_elements）：
 * 扫 body *，收 cursor:pointer / onclick / tabindex 三信号的非原生非交互 role 元素
 * （AX 树已覆盖原生控件与交互 role，不重复），排除继承 pointer 的子元素、隐藏、
 * 零尺寸、无可读文本。命中元素打 data-wa-ptr 顺序锚点供 CDP 逐个解析 backendNodeId
 * （DOM.querySelectorAll 集中拿 nodeIds 后串行 DOM.describeNode，数量 ≤ 200）。
 * 产物为 [{text}] 数组（顺序即 data-wa-ptr 序号）。字面量禁反引号与 ${（产物层）。
 */
export const POINTER_PROBE_SCRIPT: string = `(() => {
  document.querySelectorAll('[data-wa-ptr]').forEach(e => e.removeAttribute('data-wa-ptr'));
  const interactiveTags = { a:1, button:1, input:1, select:1, textarea:1, details:1, summary:1 };
  const interactiveRoles = ${JSON.stringify(
    Object.fromEntries([...AX_INTERACTIVE_ROLES].filter((r) => r !== "Iframe").map((r) => [r, 1])),
  )};
  const out = [];
  const all = document.body ? document.body.querySelectorAll('*') : [];
  for (let i = 0; i < all.length && out.length < ${POINTER_PROBE_MAX}; i++) {
    const el = all[i];
    const tag = el.tagName.toLowerCase();
    if (interactiveTags[tag]) continue;
    const role = el.getAttribute('role');
    if (role && interactiveRoles[role.toLowerCase()]) continue;
    if (el.closest && el.closest('[hidden],[aria-hidden="true"]')) continue;
    let s;
    try { s = getComputedStyle(el); } catch (e) { continue; }
    const ptr = s.cursor === 'pointer';
    const onClick = el.hasAttribute('onclick') || el.onclick !== null;
    const tabIdx = el.getAttribute('tabindex');
    const focusable = tabIdx !== null && tabIdx !== '-1';
    if (!ptr && !onClick && !focusable) continue;
    // 继承 pointer 去重：自身无额外信号且父也 pointer → 父已收，跳过
    if (ptr && !onClick && !focusable) {
      const p = el.parentElement;
      let ps = null;
      try { ps = p ? getComputedStyle(p) : null; } catch (e) {}
      if (ps && ps.cursor === 'pointer') continue;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    let text = el.getAttribute('aria-label') || el.title || (el.childNodes.length === 1 ? el.textContent : '') || '';
    text = String(text).trim().replace(/\\s+/g, ' ').slice(0, 40);
    if (!text) continue;
    el.setAttribute('data-wa-ptr', String(out.length));
    out.push({ text: text });
  }
  return out;
})()`;

/** AX 快照所需的最小视图面（WebViewLike 的结构子集：evaluate + cdp） */
export interface AxSnapshotView {
  evaluate(script: string): Promise<unknown>;
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** AX 快照产物：树形文本（含兑底附加行）、click 回查缓存、节点数（诊断） */
export interface AxSnapshot {
  text: string;
  selectorMap: Record<number, AxRefEntry>;
  nodeCount: number;
}

/**
 * 拉全量 AX 树：Page.getFrameTree 拿主 frame 的 UUID id（实测：数字 frameId 报
 * Invalid parameters，必须用 UUID）→ Accessibility.getFullAXTree（美管家实测
 * 3ms/88 节点）。失败向上抛出，由 captureStableSnapshot 降级平铺线。
 */
export async function fetchAxNodes(view: AxSnapshotView): Promise<AXNode[]> {
  const frameTree = (await view.cdp("Page.getFrameTree")) as
    | { frameTree?: { frame?: { id?: string } } }
    | undefined;
  const frameId = frameTree?.frameTree?.frame?.id;
  if (!frameId) throw new Error("无法获取主 frame id（Page.getFrameTree 未返回 frame.id）");
  const result = (await view.cdp("Accessibility.getFullAXTree", { frameId })) as
    | { nodes?: AXNode[] }
    | undefined;
  if (!result?.nodes) throw new Error("Accessibility.getFullAXTree 未返回 nodes");
  return result.nodes;
}

export interface AxSnapshotFrame {
  tree: AxTree;
  selectorMap: Record<number, AxRefEntry>;
  /** probe 原始产物（保留空 text 占位，与 data-wa-ptr 锚点序号对齐供 finalize 解析） */
  probes: { text: string }[];
  /** 轻量文本：AX 主体（无 (pointer) 标记）+ 未解析附加行（无 [ref=]），供帧间稳定比较 */
  text: string;
  nodeCount: number;
}

/**
 * AX 快照单帧（轻量）：拉树 → 重建 → ref 分配 → probe evaluate（仅收集自绘元素文本，
 * 不做 CDP 解析）。probe evaluate 抛错吞掉 → probes=[]（对齐兑底失败不影响 AX 主体）。
 * fetchAxNodes 抛错仍向上抛（触发 captureStableSnapshot 降级平铺线）。
 * 仅稳定收敛后由 finalizeAxSnapshot 对最终帧执行一次 CDP 解析；中间帧只跑本函数。
 */
export async function captureAxSnapshotFrame(view: AxSnapshotView): Promise<AxSnapshotFrame> {
  const nodes = await fetchAxNodes(view);
  const tree = buildAxTree(nodes);
  const selectorMap = assignAxRefs(tree);
  let probes: { text: string }[] = [];
  try {
    const raw = (await view.evaluate(POINTER_PROBE_SCRIPT)) as
      | { text?: unknown }[]
      | unknown[]
      | undefined;
    if (Array.isArray(raw)) {
      probes = raw.map((p) => ({ text: String((p as { text?: unknown })?.text ?? "") }));
    }
  } catch {
    // probe 失败 → 无兑底（finalize 跳过 CDP 解析链）
  }
  const body = renderAxTree(tree);
  const extraText = probes
    .filter((p) => p.text)
    .map((p) => `- generic ${JSON.stringify(p.text)} (pointer)`)
    .join("\n");
  return {
    tree,
    selectorMap,
    probes,
    text: extraText ? `${body}\n${extraText}` : body,
    nodeCount: nodes.length,
  };
}

/**
 * 兑底元素 backendNodeId 解析（仅收敛后的最终帧执行一次）：frame.probes 已打
 * data-wa-ptr="i" 锚点 → DOM.getDocument → DOM.querySelectorAll 集中拿 nodeIds →
 * 逐个 describeNode 取 backendNodeId（数量 ≤ 200，单次 <1ms）。probes 空则跳过整条
 * CDP 链。任一步失败向上抛出，由调用方降级为无兑底。
 */
async function resolvePointerBackends(
  view: AxSnapshotView,
  probes: { text: string }[],
): Promise<PointerElement[]> {
  if (probes.length === 0) return [];
  const doc = (await view.cdp("DOM.getDocument")) as { root?: { nodeId?: number } } | undefined;
  const docId = doc?.root?.nodeId;
  if (docId === undefined) return [];
  const q = (await view.cdp("DOM.querySelectorAll", {
    nodeId: docId,
    selector: "[data-wa-ptr]",
  })) as { nodeIds?: number[] } | undefined;
  const nodeIds = q?.nodeIds ?? [];
  const out: PointerElement[] = [];
  for (let i = 0; i < probes.length && i < nodeIds.length; i++) {
    const desc = (await view.cdp("DOM.describeNode", { nodeId: nodeIds[i] })) as
      | { node?: { backendNodeId?: number } }
      | undefined;
    const backendId = desc?.node?.backendNodeId;
    const text = probes[i].text;
    if (backendId !== undefined && text) out.push({ backendId, text });
  }
  return out;
}

/**
 * AX 快照收尾：对最终帧执行一次兑底 CDP 解析链 → mergePointerElements → 渲染完整
 * 快照。整段失败降级为纯 AX 主体（兑底失败不影响 AX 主体）。
 */
export async function finalizeAxSnapshot(
  frame: AxSnapshotFrame,
  view: AxSnapshotView,
): Promise<AxSnapshot> {
  let extraText = "";
  try {
    extraText = mergePointerElements(
      frame.tree,
      await resolvePointerBackends(view, frame.probes),
      frame.selectorMap,
    ).extraText;
  } catch {
    // 兑底失败不影响 AX 主体
  }
  const body = renderAxTree(frame.tree);
  return {
    text: extraText ? `${body}\n${extraText}` : body,
    selectorMap: frame.selectorMap,
    nodeCount: frame.nodeCount,
  };
}

/**
 * AX 树形快照主入口（Frame + Finalize 组合）：拉树 → 重建 → ref 分配 → 兑底合并 →
 * 渲染。兑底扫描/解析失败降级为无兑底行（AX 主体不受影响）。
 */
export async function captureAxSnapshot(view: AxSnapshotView): Promise<AxSnapshot> {
  return finalizeAxSnapshot(await captureAxSnapshotFrame(view), view);
}

/** ref 点击定位产物：坐标为视口相对（quad 中心）；recovered 标记失效回查 */
export interface RefClickTarget {
  backendNodeId: number;
  x: number;
  y: number;
  recovered: boolean;
}

/**
 * ref 点击定位（对齐 agent-browser element.rs）：先 scrollIntoViewIfNeeded（保证
 * 可见可点；display:none/detached 会在此或 getBoxModel 抛错）→ DOM.getBoxModel 取
 * content quad 四点平均为中心（视口相对坐标，与 view.click 同系）。原 backendNodeId
 * 失效 → 重拉 AX 按 role+name 唯一匹配回查（多命中歧义报错、零命中报错，对齐
 * select_unique_node_id 的宁失效不错点语义）。
 */
export async function locateRefTarget(
  view: AxSnapshotView,
  backendNodeId: number,
  entry: AxRefEntry,
): Promise<RefClickTarget> {
  const direct = await boxModelCenter(view, backendNodeId);
  if (direct) return { backendNodeId, x: direct.x, y: direct.y, recovered: false };
  const freshId = await recoverBackendIdByRoleName(view, entry);
  const center = await boxModelCenter(view, freshId);
  if (!center) {
    throw new Error(
      `ref 回查到的元素（${entry.role} "${entry.name}"）无法定位坐标，请重新 browser_snapshot`,
    );
  }
  return { backendNodeId: freshId, x: center.x, y: center.y, recovered: true };
}

/**
 * scrollIntoViewIfNeeded + getBoxModel → content quad 四点平均中心；失败返回 null。
 * 实测钉死：DOM.getBoxModel 的 quad 是**视口坐标**（先 scrollIntoViewIfNeeded 滚入
 * 视口，quad 与 getBoundingClientRect 一致；实测滚动页 y=270=gBR y=282 同系），
 * 与 view.click/Input 事件同坐标系，直接使用（对齐 agent-browser element.rs 流程）。
 */
async function boxModelCenter(
  view: AxSnapshotView,
  backendNodeId: number,
): Promise<{ x: number; y: number } | null> {
  try {
    await view.cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    const model = (await view.cdp("DOM.getBoxModel", { backendNodeId })) as
      | { model?: { content?: number[] } }
      | undefined;
    const quad = model?.model?.content;
    if (!quad || quad.length < 8) return null;
    let x = 0;
    let y = 0;
    for (let i = 0; i < 8; i += 2) {
      x += quad[i];
      y += quad[i + 1];
    }
    return { x: Math.round(x / 4), y: Math.round(y / 4) };
  } catch {
    return null; // 元素已不存在等失效场景 → 上层回查
  }
}

/**
 * 按 role+name 在全量 AX 树里唯一匹配 backendDOMNodeId（ignored 节点不参与；
 * 多命中报歧义要求重新 snapshot——快照曾有多个同型元素时无法安全恢复）。
 */
export async function recoverBackendIdByRoleName(
  view: AxSnapshotView,
  entry: AxRefEntry,
): Promise<number> {
  const nodes = await fetchAxNodes(view);
  let found: AXNode | undefined;
  for (const node of nodes) {
    if (node.ignored === true) continue;
    if (
      normalizeAxRole(extractAxString(node.role)) === entry.role &&
      extractAxString(node.name) === entry.name
    ) {
      if (found) {
        throw new Error(
          `ref 回查歧义：role=${entry.role} name="${entry.name}" 现在匹配多个元素。请重新 browser_snapshot 后使用新 ref`,
        );
      }
      found = node;
    }
  }
  if (!found) {
    throw new Error(
      `回查失败：页面上已找不到 ${entry.role} "${entry.name}"（页面可能已变化），请重新 browser_snapshot`,
    );
  }
  const id = found.backendDOMNodeId;
  if (id === undefined) {
    throw new Error(`回查到的 AX 节点无 backendDOMNodeId（${entry.role} "${entry.name}"）`);
  }
  return id;
}
