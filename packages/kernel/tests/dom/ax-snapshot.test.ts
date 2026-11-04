// dom/ax-snapshot.test.ts —— AX 树快照模块单元测试（Layer 1）。
//
// fixture 手工编排 CDP Accessibility.getFullAXTree 的 AXNode 形状（nodeId/childIds/
// role.name.value 为 AXValue 包裹、properties 携带 checked），覆盖：角色分类、
// ignored 折叠、StaticText 聚合去重、树形渲染、兜底合并、click 回查。
import { describe, expect, test } from "bun:test";
import {
  assignAxRefs,
  buildAxTree,
  captureAxSnapshot,
  captureAxSnapshotFrame,
  finalizeAxSnapshot,
  classifyAxRole,
  extractAxString,
  locateRefTarget,
  mergePointerElements,
  normalizeAxRole,
  POINTER_PROBE_SCRIPT,
  renderAxTree,
  type AXNode,
  type AxSnapshotView,
  type AXValue,
} from "../../src/dom/ax-snapshot";

/** 便捷构造 AXNode（role/name/value 包 AXValue，其余直传） */
function ax(
  nodeId: string,
  role: string,
  opts: Partial<{
    name: string;
    value: string;
    backendDOMNodeId: number;
    ignored: boolean;
    childIds: string[];
    checked: string;
  }> = {},
): AXNode {
  const node: AXNode = { nodeId };
  if (role) node.role = { type: "role", value: role };
  if (opts.name !== undefined) node.name = { type: "computedString", value: opts.name };
  if (opts.value !== undefined) node.value = { type: "string", value: opts.value };
  if (opts.backendDOMNodeId !== undefined) node.backendDOMNodeId = opts.backendDOMNodeId;
  if (opts.ignored) node.ignored = true;
  if (opts.childIds) node.childIds = opts.childIds;
  if (opts.checked !== undefined) {
    node.properties = [{ name: "checked", value: { type: "token", value: opts.checked } }];
  }
  return node;
}

describe("classifyAxRole 角色分类（对齐 agent-browser）", () => {
  test("INTERACTIVE：无条件 ref（含表格单元格）", () => {
    for (const r of [
      "button", "link", "textbox", "checkbox", "radio", "combobox", "listbox",
      "menuitem", "menuitemcheckbox", "menuitemradio", "option", "searchbox",
      "slider", "spinbutton", "switch", "tab", "treeitem", "Iframe",
      "cell", "gridcell", "columnheader", "rowheader",
    ]) {
      expect(classifyAxRole(r)).toBe("interactive");
    }
  });

  test("CONTENT：有可访问名才 ref", () => {
    for (const r of ["heading", "listitem", "article", "region", "main", "navigation"]) {
      expect(classifyAxRole(r)).toBe("content");
    }
  });

  test("STRUCTURAL：不 ref 不剪枝仅遍历；未知角色安全缺省为 structural", () => {
    for (const r of [
      "generic", "group", "list", "table", "row", "rowgroup", "grid", "treegrid",
      "menu", "menubar", "toolbar", "tablist", "tree", "directory", "document",
      "application", "presentation", "none", "WebArea", "RootWebArea",
    ]) {
      expect(classifyAxRole(r)).toBe("structural");
    }
    expect(classifyAxRole("SomeNewRole")).toBe("structural");
  });

  test("StaticText 特判为 text（文本内容行，无 ref）", () => {
    expect(classifyAxRole("StaticText")).toBe("text");
  });
});

describe("normalizeAxRole / extractAxString", () => {
  test("IframePresentational 归一为 Iframe（同 iframe 的快照 ref 与回查语义一致）", () => {
    expect(normalizeAxRole("IframePresentational")).toBe("Iframe");
    expect(normalizeAxRole("button")).toBe("button");
  });

  test("extractAxString：string/number/bool 序列化，缺省空串", () => {
    expect(extractAxString({ type: "computedString", value: "登 录" })).toBe("登 录");
    expect(extractAxString({ type: "integer", value: 3 })).toBe("3");
    expect(extractAxString({ type: "boolean", value: true })).toBe("true");
    expect(extractAxString(undefined)).toBe("");
  });
});

/** 美管家登录页形态的基准 fixture：root → heading+文本+textbox+button */
function loginPageFixture(): AXNode[] {
  return [
    ax("1", "RootWebArea", { name: "慧来客", backendDOMNodeId: 1, childIds: ["2", "3", "4", "5"] }),
    ax("2", "heading", { name: "慧来客", backendDOMNodeId: 10, childIds: ["6"] }),
    ax("6", "StaticText", { name: "慧来客" }),
    ax("3", "StaticText", { name: "手机号登录后可进行后续操作" }),
    ax("4", "textbox", { name: "请输入您的手机号码", value: "", backendDOMNodeId: 12 }),
    ax("5", "button", { name: "登 录", backendDOMNodeId: 15 }),
  ];
}

describe("assignAxRefs + renderAxTree 树形渲染", () => {
  test("美管家登录页形态：heading 有名带 ref、text 无 ref、textbox/button 带 [ref=backendId]", () => {
    const tree = buildAxTree(loginPageFixture());
    const map = assignAxRefs(tree);
    const text = renderAxTree(tree);
    const lines = text.split("\n");
    expect(lines).toStrictEqual([
      '- heading "慧来客" [ref=10]',
      '- text "手机号登录后可进行后续操作"',
      '- textbox "请输入您的手机号码" = "" [ref=12]',
      '- button "登 录" [ref=15]',
    ]);
    // selectorMap：ref → {role,name}（click 回查缓存）
    expect(map[10]).toStrictEqual({ role: "heading", name: "慧来客" });
    expect(map[12]).toStrictEqual({ role: "textbox", name: "请输入您的手机号码" });
    expect(map[15]).toStrictEqual({ role: "button", name: "登 录" });
    expect(map[1]).toBeUndefined(); // 根包装不分配
  });

  test("根包装（RootWebArea/WebArea）不出现在输出，children 从顶层开始", () => {
    const text = renderAxTree(buildAxTree(loginPageFixture()));
    expect(text).not.toContain("RootWebArea");
    expect(text.startsWith("- heading")).toBe(true);
  });

  test("层级缩进：2 空格递进反映树形结构", () => {
    const nodes = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2"] }),
      ax("2", "navigation", { name: "主导航", backendDOMNodeId: 2, childIds: ["3"] }),
      ax("3", "list", { backendDOMNodeId: 3, childIds: ["4", "5"] }),
      ax("4", "listitem", { name: "首页", backendDOMNodeId: 4 }),
      ax("5", "listitem", { name: "设置", backendDOMNodeId: 5 }),
    ];
    const text = renderAxTree(buildAxTree(nodes));
    const lines = text.split("\n");
    expect(lines[0]).toBe('- navigation "主导航" [ref=2]');
    expect(lines[1]).toBe("  - list"); // 结构行无 ref 无名
    expect(lines[2]).toBe('    - listitem "首页" [ref=4]');
    expect(lines[3]).toBe('    - listitem "设置" [ref=5]');
  });

  test("generic 折叠：无 ref 且单子 → 提升子到祖父层；多子保留 generic 行", () => {
    const nodes = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2", "6"] }),
      ax("2", "generic", { backendDOMNodeId: 2, childIds: ["3"] }),
      ax("3", "button", { name: "单子按钮", backendDOMNodeId: 3 }),
      ax("6", "generic", { backendDOMNodeId: 6, childIds: ["7", "8"] }),
      ax("7", "button", { name: "按钮甲", backendDOMNodeId: 7 }),
      ax("8", "button", { name: "按钮乙", backendDOMNodeId: 8 }),
    ];
    const lines = renderAxTree(buildAxTree(nodes)).split("\n");
    // 单子 generic 折叠：button 直接出现在顶层
    expect(lines[0]).toBe('- button "单子按钮" [ref=3]');
    // 多子 generic 保留为结构行
    expect(lines[1]).toBe("- generic");
    expect(lines[2]).toBe('  - button "按钮甲" [ref=7]');
  });

  test("空名 StaticText 跳过（空白文本节点不产噪音行）", () => {
    const nodes = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2", "3"] }),
      ax("2", "StaticText", { name: "   " }),
      ax("3", "button", { name: "按钮", backendDOMNodeId: 3 }),
    ];
    const lines = renderAxTree(buildAxTree(nodes)).split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe('- button "按钮" [ref=3]');
  });

  test("name/value 经 JSON 转义（含引号名安全显示）", () => {
    const nodes = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2"] }),
      ax("2", "button", { name: '带"引号"的按钮', backendDOMNodeId: 2 }),
    ];
    const lines = renderAxTree(buildAxTree(nodes)).split("\n");
    expect(lines[0]).toBe('- button "带\\"引号\\"的按钮" [ref=2]');
  });

  test("checkbox 勾选态：checked=true 显示 [checked]，mixed 显示 [checked=mixed]，false 不显示", () => {
    const nodes = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2", "3", "4"] }),
      ax("2", "checkbox", { name: "甲", backendDOMNodeId: 2, checked: "true" }),
      ax("3", "checkbox", { name: "乙", backendDOMNodeId: 3, checked: "mixed" }),
      ax("4", "checkbox", { name: "丙", backendDOMNodeId: 4, checked: "false" }),
    ];
    const lines = renderAxTree(buildAxTree(nodes)).split("\n");
    expect(lines[0]).toBe('- checkbox "甲" [checked] [ref=2]');
    expect(lines[1]).toBe('- checkbox "乙" [checked=mixed] [ref=3]');
    expect(lines[2]).toBe('- checkbox "丙" [ref=4]');
  });

  test("value 与 name 相同时不重复显示（对齐 agent-browser）", () => {
    const nodes = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2"] }),
      ax("2", "textbox", { name: "预填文本", value: "预填文本", backendDOMNodeId: 2 }),
    ];
    const lines = renderAxTree(buildAxTree(nodes)).split("\n");
    expect(lines[0]).toBe('- textbox "预填文本" [ref=2]');
  });

  test("CONTENT 无名不带 ref（article 无可访问名）", () => {
    const nodes = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2"] }),
      ax("2", "article", { backendDOMNodeId: 2 }),
    ];
    const map = assignAxRefs(buildAxTree(nodes));
    expect(Object.keys(map).length).toBe(0);
    const tree2 = buildAxTree(nodes);
    assignAxRefs(tree2);
    expect(renderAxTree(tree2)).toBe("- article");
  });
});

describe("mergePointerElements 兜底合并（cursor:pointer 自绘件）", () => {
  /** generic 容器 + StaticText 子（美管家自绘卡片形态） */
  function cardFixture(): ReturnType<typeof buildAxTree> {
    const nodes = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2", "3"] }),
      ax("2", "button", { name: "原生按钮", backendDOMNodeId: 2 }),
      ax("3", "generic", { backendDOMNodeId: 3, childIds: ["4"] }),
      ax("4", "StaticText", { name: "自绘文本" }),
    ];
    return buildAxTree(nodes);
  }

  test("backendId 命中 AX 节点：标 (pointer) 并强制 ref（structural 也给 ref），无附加行", () => {
    const tree = cardFixture();
    const map = assignAxRefs(tree);
    const { extraText } = mergePointerElements(tree, [{ backendId: 3, text: "自绘文本" }], map);
    const text = renderAxTree(tree);
    // generic 单子本应折叠，但 pointer 强制 ref 后保留为可点行
    expect(text).toContain("- generic [ref=3] (pointer)");
    expect(text).toContain('  - text "自绘文本"');
    expect(extraText).toBe("");
    // selectorMap 增补（强制 ref 的元素可被 click ref 回查）
    expect(map[3]).toStrictEqual({ role: "generic", name: "" });
  });

  test("未命中 AX 树 → 附加行（树主体后，标 ref 与 (pointer)），selectorMap 增补", () => {
    const tree = cardFixture();
    const map = assignAxRefs(tree);
    const { extraText } = mergePointerElements(tree, [{ backendId: 99, text: "纯兑底元素" }], map);
    expect(extraText).toBe('- generic "纯兑底元素" [ref=99] (pointer)');
    expect(map[99]).toStrictEqual({ role: "generic", name: "纯兑底元素" });
    // 附加行不属于树主体（同元素不重复出现由命中分支保证）
    expect(renderAxTree(tree)).not.toContain("纯兑底元素");
  });

  test("多个兑底元素逐行附加，保持传入顺序", () => {
    const tree = cardFixture();
    const map = assignAxRefs(tree);
    const { extraText } = mergePointerElements(
      tree,
      [{ backendId: 99, text: "甲" }, { backendId: 100, text: "乙" }],
      map,
    );
    expect(extraText.split("\n")).toStrictEqual([
      '- generic "甲" [ref=99] (pointer)',
      '- generic "乙" [ref=100] (pointer)',
    ]);
  });

  test("兑底元素文本经 JSON 转义", () => {
    const tree = cardFixture();
    const map = assignAxRefs(tree);
    const { extraText } = mergePointerElements(tree, [{ backendId: 7, text: '含"引号' }], map);
    expect(extraText).toBe('- generic "含\\"引号" [ref=7] (pointer)');
  });
});

describe("POINTER_PROBE_SCRIPT 兑底扫描脚本", () => {
  test("合法 JS 自执行 IIFE，产物无反引号/插值残留，含 data-wa-ptr 标记与 cursor 判定", () => {
    expect(() => new Function(POINTER_PROBE_SCRIPT)).not.toThrow();
    expect(POINTER_PROBE_SCRIPT.trimEnd().endsWith("})()")).toBe(true);
    expect(POINTER_PROBE_SCRIPT).not.toContain("`");
    expect(POINTER_PROBE_SCRIPT).not.toContain("${");
    expect(POINTER_PROBE_SCRIPT).toContain("data-wa-ptr");
    expect(POINTER_PROBE_SCRIPT).toContain("pointer");
  });

  test("排除原生交互标签与交互 role（AX 树已覆盖，不重复扫描）", () => {
    expect(POINTER_PROBE_SCRIPT).toContain("interactiveTags");
    expect(POINTER_PROBE_SCRIPT).toContain("interactiveRoles");
    expect(POINTER_PROBE_SCRIPT).toContain('button:1');
    // 交互 role 排除集来自 AX 全表同源注入（searchbox 修复后不含 search）
    expect(POINTER_PROBE_SCRIPT).toContain('"searchbox":1');
    expect(POINTER_PROBE_SCRIPT).not.toContain('"search":1');
  });
});

describe("locateRefTarget click ref 回查（对齐 element.rs select_unique_node_id）", () => {
  /** fake 视图：getBoxModel 按 backendId 命中表返回 quad / 抛错（失效） */
  function fakeClickView(
    axNodes: AXNode[],
    boxes: Record<number, number[]>,
    opts: { failFirst?: number } = {},
  ): AxSnapshotView & { calls: { method: string; params?: Record<string, unknown> }[] } {
    const calls: { method: string; params?: Record<string, unknown> }[] = [];
    let boxCalls = 0;
    return {
      calls,
      async evaluate() {
        return [];
      },
      async cdp(method: string, params?: Record<string, unknown>) {
        calls.push({ method, params });
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "uuid-1" } } };
        if (method === "Accessibility.getFullAXTree") return { nodes: axNodes };
        if (method === "DOM.scrollIntoViewIfNeeded") return {};
        if (method === "DOM.getBoxModel") {
          boxCalls++;
          const id = Number(params?.backendNodeId);
          if (opts.failFirst !== undefined && boxCalls <= opts.failFirst) {
            throw new Error("No node with id");
          }
          const quad = boxes[id];
          if (!quad) throw new Error("No node with id " + id);
          return { model: { content: quad } };
        }
        return {};
      },
    };
  }

  const axNodes = () => [
    ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2", "3"] }),
    ax("2", "button", { name: "登 录", backendDOMNodeId: 15 }),
    ax("3", "button", { name: "注册", backendDOMNodeId: 16 }),
  ];

  test("缓存命中：先 scrollIntoViewIfNeeded 再 getBoxModel，quad 四点平均为中心坐标", async () => {
    const view = fakeClickView(axNodes(), { 15: [10, 20, 30, 20, 30, 40, 10, 40] });
    const t = await locateRefTarget(view, 15, { role: "button", name: "登 录" });
    expect(t).toStrictEqual({ backendNodeId: 15, x: 20, y: 30, recovered: false });
    const idxScroll = view.calls.findIndex((c) => c.method === "DOM.scrollIntoViewIfNeeded");
    const idxBox = view.calls.findIndex((c) => c.method === "DOM.getBoxModel");
    expect(idxScroll).toBeGreaterThanOrEqual(0);
    expect(idxBox).toBeGreaterThan(idxScroll); // 先滚入视口再取坐标
    expect(view.calls.some((c) => c.method === "Accessibility.getFullAXTree")).toBe(false);
  });

  test("原 ref 失效（getBoxModel 抛错）→ 重拉 AX 按 role+name 唯一匹配新 backendId", async () => {
    // 第一次 getBoxModel（旧 id=99）抛错；AX 树里同 role+name 的节点现在是 15
    const view = fakeClickView(axNodes(), { 15: [0, 0, 20, 0, 20, 10, 0, 10] }, { failFirst: 1 });
    const t = await locateRefTarget(view, 99, { role: "button", name: "登 录" });
    expect(t.backendNodeId).toBe(15);
    expect(t.recovered).toBe(true);
    expect(t.x).toBe(10);
    expect(t.y).toBe(5);
  });

  test("重名歧义：role+name 匹配多个元素 → 报错要求重新 snapshot（宁失效不错点）", async () => {
    const dup = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2", "3"] }),
      ax("2", "button", { name: "登 录", backendDOMNodeId: 15 }),
      ax("3", "button", { name: "登 录", backendDOMNodeId: 16 }),
    ];
    const view = fakeClickView(dup, {}, { failFirst: 1 });
    const err = await locateRefTarget(view, 99, { role: "button", name: "登 录" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("多个");
    expect(err!.message).toContain("button");
    expect(err!.message).toContain("重新 browser_snapshot");
  });

  test("零命中：页面上已找不到该 role+name → 报错提示重新 snapshot", async () => {
    const view = fakeClickView(axNodes(), {}, { failFirst: 1 });
    const err = await locateRefTarget(view, 99, { role: "button", name: "不存在" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("找不到");
  });

  test("回查到的元素坐标也取不到 → 报错（不返回坏坐标）", async () => {
    const view = fakeClickView(axNodes(), {}, { failFirst: 2 });
    const err = await locateRefTarget(view, 99, { role: "button", name: "登 录" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
  });

  test("ignored 节点不参与回查匹配（只认未忽略节点）", async () => {
    const withIgnored = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2"] }),
      ax("2", "button", { name: "隐藏按钮", backendDOMNodeId: 20, ignored: true }),
    ];
    const view = fakeClickView(withIgnored, {}, { failFirst: 1 });
    const err = await locateRefTarget(view, 99, { role: "button", name: "隐藏按钮" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err!.message).toContain("找不到");
  });
});

describe("captureAxSnapshot AX 拉取与快照产物", () => {
  /** fake 视图：记录 cdp 调用，按方法名返回预设响应 */
  function fakeAxView(
    nodes: AXNode[],
    opts: {
      pointers?: { text: string }[];
      nodeIds?: number[];
      backendIds?: number[];
      failCdp?: boolean;
      failProbe?: boolean;
    } = {},
  ): AxSnapshotView & { calls: { method: string; params?: Record<string, unknown> }[] } {
    const calls: { method: string; params?: Record<string, unknown> }[] = [];
    return {
      calls,
      async evaluate(script: string) {
        if (script.includes("data-wa-ptr")) {
          if (opts.failProbe) throw new Error("probe boom");
          return opts.pointers ?? [];
        }
        return script;
      },
      async cdp(method: string, params?: Record<string, unknown>) {
        calls.push({ method, params });
        if (opts.failCdp) throw new Error("cdp boom");
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "uuid-1234-AB" } } };
        if (method === "Accessibility.getFullAXTree") return { nodes };
        if (method === "DOM.getDocument") return { root: { nodeId: 5 } };
        if (method === "DOM.querySelectorAll") return { nodeIds: opts.nodeIds ?? [] };
        if (method === "DOM.describeNode") {
          const requested = Number(params?.nodeId ?? -1);
          const pos = (opts.nodeIds ?? []).indexOf(requested);
          return { node: { backendNodeId: pos >= 0 ? (opts.backendIds?.[pos] ?? requested * 10) : requested * 10 } };
        }
        return {};
      },
    };
  }

  test("T2: Frame 轻量文本：附加行含 (pointer) 不含 [ref=]，AX 主体无 (pointer) 标注", async () => {
    const view = fakeAxView(loginPageFixture(), {
      pointers: [{ text: "自绘卡片" }],
      nodeIds: [100],
      backendIds: [555],
    });
    const frame = await captureAxSnapshotFrame(view);
    expect(frame.text).toContain('- generic "自绘卡片" (pointer)');
    // 附加行不含 [ref=]（解析前未知 backendId），AX 主体行不受影响
    const extraLine = frame.text.split("\n").find((l) => l.includes("自绘卡片"));
    expect(extraLine).toBe('- generic "自绘卡片" (pointer)');
    // AX 主体行保持原样（无 (pointer) 强制标注，merge 未发生）
    expect(frame.text).toContain('- button "登 录" [ref=15]');
    expect(frame.text.split("\n").filter((l) => l.includes("(pointer)")).length).toBe(1);
    expect(frame.nodeCount).toBe(6);
    // Frame 阶段未跑 CDP 解析链
    expect(view.calls.some((c) => c.method === "DOM.describeNode")).toBe(false);
  });

  test("T6: Frame→Finalize 组装：probe 命中 AX 节点 → 主体行标 (pointer) 强制 ref，无重复附加行", async () => {
    // probe backendId=15 命中「登 录」button（对齐既有 fakeAxView 用例口径）
    const view = fakeAxView(loginPageFixture(), {
      pointers: [{ text: "登 录" }],
      nodeIds: [100],
      backendIds: [15],
    });
    const frame = await captureAxSnapshotFrame(view);
    const snap = await finalizeAxSnapshot(frame, view);
    expect(snap.text).toContain('- button "登 录" [ref=15] (pointer)');
    expect(snap.text.split("\n").filter((l) => l.includes("登 录")).length).toBe(1);
    expect(snap.selectorMap[15]).toStrictEqual({ role: "button", name: "登 录" });
  });

  test("getFullAXTree 传入 Page.getFrameTree 的 UUID frameId（数字 frameId 会 Invalid parameters）", async () => {
    const view = fakeAxView(loginPageFixture());
    await captureAxSnapshot(view);
    const axCall = view.calls.find((c) => c.method === "Accessibility.getFullAXTree");
    expect(axCall).toBeDefined();
    expect(axCall!.params).toStrictEqual({ frameId: "uuid-1234-AB" });
  });

  test("产出树形 text + selectorMap + nodeCount；兜底链 evaluate→getDocument→querySelectorAll→describeNode", async () => {
    const view = fakeAxView(loginPageFixture(), {
      pointers: [{ text: "自绘卡片" }],
      nodeIds: [100],
      backendIds: [555], // describeNode(nodeId=100) → backendNodeId 555（不在 AX 树 → 附加行）
    });
    const snap = await captureAxSnapshot(view);
    expect(snap.nodeCount).toBe(6);
    expect(snap.text).toContain('- button "登 录" [ref=15]');
    expect(snap.text).toContain('- generic "自绘卡片" [ref=555] (pointer)');
    expect(snap.selectorMap[555]).toStrictEqual({ role: "generic", name: "自绘卡片" });
    expect(snap.selectorMap[15]).toStrictEqual({ role: "button", name: "登 录" });
    expect(view.calls.some((c) => c.method === "DOM.querySelectorAll")).toBe(true);
  });

  test("兜底元素命中 AX 树时按 backendId 去重（describeNode 解析后不在附加区重复）", async () => {
    // pointer 元素 backendId=15 命中 button「登 录」→ 不附加，button 行标 (pointer)
    const view = fakeAxView(loginPageFixture(), {
      pointers: [{ text: "登 录" }],
      nodeIds: [100],
      backendIds: [15],
    });
    const snap = await captureAxSnapshot(view);
    expect(snap.text).toContain('- button "登 录" [ref=15] (pointer)');
    expect(snap.text.split("\n").filter((l) => l.includes("登 录")).length).toBe(1);
  });

  test("仅根节点（无 children）→ 空文本（AX 版空判定）", async () => {
    const view = fakeAxView([ax("1", "RootWebArea", { backendDOMNodeId: 1 })]);
    const snap = await captureAxSnapshot(view);
    expect(snap.text).toBe("");
  });

  test("cdp 抛错（getFullAXTree 失败）→ 向上抛出，由 captureStableSnapshot 降级平铺线", async () => {
    const view = fakeAxView(loginPageFixture(), { failCdp: true });
    expect(await captureAxSnapshot(view).then(() => null, (e) => e)).toBeInstanceOf(Error);
  });

  test("兑底扫描失败不阻断主体（降级为无兑底行）", async () => {
    const view = fakeAxView(loginPageFixture(), { failProbe: true });
    const snap = await captureAxSnapshot(view);
    expect(snap.text).toContain('- button "登 录" [ref=15]');
    expect(snap.text).not.toContain("(pointer)");
  });
});

describe("buildAxTree 树构建（childIds 重建/折叠/聚合去重）", () => {
  test("childIds 重建父子：根唯一，子按序挂接，字段提取完整", () => {
    const tree = buildAxTree(loginPageFixture());
    expect(tree.roots.length).toBe(1);
    const root = tree.roots[0];
    expect(root.role).toBe("RootWebArea");
    expect(root.children.map((c) => c.role)).toStrictEqual([
      "heading", "StaticText", "textbox", "button",
    ]);
    const textbox = root.children[2];
    expect(textbox.backendDOMNodeId).toBe(12);
    expect(textbox.name).toBe("请输入您的手机号码");
    expect(textbox.value).toBe(""); // value 字段存在（空串）≠ 无字段
    expect(root.children[3].backendDOMNodeId).toBe(15);
  });

  test("ignored 节点折叠：自身不出现，children 提升到父层（不丢子树）", () => {
    const nodes = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2"] }),
      ax("2", "generic", { ignored: true, childIds: ["3", "4"] }),
      ax("3", "button", { name: "菜单", backendDOMNodeId: 30 }),
      ax("4", "link", { name: "帮助", backendDOMNodeId: 31 }),
    ];
    const tree = buildAxTree(nodes);
    expect(tree.roots[0].children.length).toBe(2);
    expect(tree.roots[0].children.map((c) => c.role)).toStrictEqual(["button", "link"]);
  });

  test("InlineTextBox 跳过（HTML 片段级文本是渲染产物非语义）", () => {
    const nodes = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2"] }),
      ax("2", "paragraph", { childIds: ["3", "4"] }),
      ax("3", "InlineTextBox", { name: "片段一" }),
      ax("4", "StaticText", { name: "正文" }),
    ];
    const tree = buildAxTree(nodes);
    const para = tree.roots[0].children[0];
    expect(para.role).toBe("paragraph");
    expect(para.children.map((c) => c.role)).toStrictEqual(["StaticText"]);
    expect(para.children[0].name).toBe("正文");
  });

  test("连续 StaticText 聚合到首个（内联标签拆分的同段文本）", () => {
    const nodes = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2"] }),
      ax("2", "generic", { backendDOMNodeId: 2, childIds: ["3", "4", "5"] }),
      ax("3", "StaticText", { name: "库存" }),
      ax("4", "StaticText", { name: "：" }),
      ax("5", "StaticText", { name: "100" }),
    ];
    const tree = buildAxTree(nodes);
    const kids = tree.roots[0].children[0].children;
    expect(kids.length).toBe(1);
    expect(kids[0].name).toBe("库存：100");
  });

  test("单 StaticText 与父 name 相同 → 去重剔除（heading 文本不重复两行）", () => {
    const tree = buildAxTree(loginPageFixture());
    const heading = tree.roots[0].children[0];
    expect(heading.name).toBe("慧来客");
    expect(heading.children.length).toBe(0); // 子 StaticText "慧来客" 与父同名被剔除
  });

  test("多根（无 childIds 关联的孤儿节点）都作为 root 返回", () => {
    const nodes = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2"] }),
      ax("2", "button", { name: "A", backendDOMNodeId: 2 }),
      ax("9", "RootWebArea", { name: "二", backendDOMNodeId: 9 }),
    ];
    const tree = buildAxTree(nodes);
    expect(tree.roots.length).toBe(2);
  });

  test("checked 从 properties 提取（checkbox/radio 勾选态）", () => {
    const nodes = [
      ax("1", "RootWebArea", { backendDOMNodeId: 1, childIds: ["2"] }),
      ax("2", "checkbox", { name: "同意协议", backendDOMNodeId: 20, checked: "true" }),
    ];
    const tree = buildAxTree(nodes);
    expect(tree.roots[0].children[0].checked).toBe("true");
  });

  test("allBackendIds 收集全树 backendDOMNodeId（兜底去重用），无 id 节点不误收", () => {
    const tree = buildAxTree(loginPageFixture());
    expect(tree.allBackendIds.has(1)).toBe(true);
    expect(tree.allBackendIds.has(10)).toBe(true);
    expect(tree.allBackendIds.has(12)).toBe(true);
    expect(tree.allBackendIds.has(15)).toBe(true);
    expect(tree.allBackendIds.size).toBe(4);
  });
});
