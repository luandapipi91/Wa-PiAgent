// browser-annotate.test.ts —— 标注注入脚本模块的单元测试（Layer 1）。
//
// ANNOTATE_SCRIPT / resolveRefScript 是要注入真实页面执行的 JS 字符串，
// 这里验证：脚本合法性（可被 new Function 解析）、关键行为标记（清除旧标注、
// scrollIntoView）、枚举上限常量，以及 resolveRefScript 对非法入参的防注入校验。
import { describe, expect, test } from "bun:test";
import type { WebViewLike } from "../src/browser-manager";
import type { AXNode } from "../src/dom/ax-snapshot";
import {
  ANNOTATE_SCRIPT,
  INTERACTIVE_ROLE_SELECTOR,
  INTERACTIVE_ROLES,
  MAX_ANNOTATED_ELEMENTS,
  SNAPSHOT_SCRIPT,
  captureStableSnapshot,
  clickTextScript,
  diffSnapshotLines,
  formatSnapshot,
  hoverLocateScript,
  occlusionProbeScript,
} from "../src/browser-annotate";

describe("browser-annotate 注入脚本", () => {
  test("ANNOTATE_SCRIPT 是合法 JS 且为自执行 IIFE", () => {
    expect(() => new Function(ANNOTATE_SCRIPT)).not.toThrow();
    expect(ANNOTATE_SCRIPT.trimEnd().endsWith("})()")).toBe(true);
    // 禁止反引号与 ${（全局约束：外层用 TS 模板字符串包裹时不踩转义）
    expect(ANNOTATE_SCRIPT).not.toContain("`");
    expect(ANNOTATE_SCRIPT).not.toContain("${");
  });

  test("ANNOTATE_SCRIPT 先清除旧标注再枚举可交互元素（data-wa-ref 锚点已退役）", () => {
    expect(ANNOTATE_SCRIPT).toContain("data-wa-annotate");
    expect(ANNOTATE_SCRIPT).not.toContain("data-wa-ref");
    expect(ANNOTATE_SCRIPT).toContain("getBoundingClientRect");
  });

  test("ANNOTATE_SCRIPT 枚举上限为 MAX_ANNOTATED_ELEMENTS", () => {
    expect(ANNOTATE_SCRIPT).toContain("200");
    expect(MAX_ANNOTATED_ELEMENTS).toBe(200);
  });
});

describe("INTERACTIVE_ROLES 角色白名单（ARIA 1.2 核对）", () => {
  test("输入类角色用 ARIA 1.2 规范名：searchbox（非 search）+ spinbutton/listbox 齐备", () => {
    const roles = INTERACTIVE_ROLES as readonly string[];
    // ARIA 1.2：role=search 是 landmark 容器（非交互），交互输入角色是 searchbox；
    // 现状漏写会导致 role=searchbox 的输入框不进快照/标注
    expect(roles).toContain("searchbox");
    expect(roles).not.toContain("search");
    // ARIA 1.2 widget 角色全表核对补齐
    expect(roles).toContain("spinbutton");
    expect(roles).toContain("listbox");
  });

  test("既有交互角色保留（button/link/checkbox/radio/tab/menu*/option/switch/combobox/textbox/slider/treeitem）", () => {
    const roles = INTERACTIVE_ROLES as readonly string[];
    for (const r of [
      "button", "link", "checkbox", "radio", "tab", "menuitem",
      "menuitemcheckbox", "menuitemradio", "option", "switch",
      "combobox", "textbox", "slider", "treeitem",
    ]) {
      expect(roles).toContain(r);
    }
  });

  test("角色选择器串与白名单同源（searchbox 进 selector）", () => {
    expect(INTERACTIVE_ROLE_SELECTOR).toContain('[role="searchbox"]');
    expect(INTERACTIVE_ROLE_SELECTOR).not.toContain('[role="search"]');
  });
});

describe("SNAPSHOT_SCRIPT 文本快照注入脚本", () => {
  test("合法 JS 且为自执行 IIFE，产物无反引号/插值残留", () => {
    expect(() => new Function(SNAPSHOT_SCRIPT)).not.toThrow();
    expect(SNAPSHOT_SCRIPT.trimEnd().endsWith("})()")).toBe(true);
    expect(SNAPSHOT_SCRIPT).not.toContain("`");
    expect(SNAPSHOT_SCRIPT).not.toContain("${");
  });

  test("纯文本快照（data-wa-ref 锚点已退役，不再打 DOM 锚点）", () => {
    expect(SNAPSHOT_SCRIPT).not.toContain("data-wa-ref");
    expect(SNAPSHOT_SCRIPT).not.toContain("data-wa-annotate");
  });

  test("枚举覆盖交互 role 白名单与 cursor:pointer 非原生元素", () => {
    expect(SNAPSHOT_SCRIPT).toContain('[role="button"]');
    expect(SNAPSHOT_SCRIPT).toContain("cursor");
    expect(SNAPSHOT_SCRIPT).toContain("labels"); // checkbox 关联 label 取名
    expect(SNAPSHOT_SCRIPT).toContain("password"); // 密码打码
    expect(INTERACTIVE_ROLE_SELECTOR).toContain('[role="menuitem"]');
  });

  test("枚举上限与 ANNOTATE_SCRIPT 同源（MAX_ANNOTATED_ELEMENTS 插值）", () => {
    expect(SNAPSHOT_SCRIPT).toContain(String(MAX_ANNOTATED_ELEMENTS));
    expect(MAX_ANNOTATED_ELEMENTS).toBe(200);
  });
});

describe("captureStableSnapshot 双线（AX 优先 / 平铺降级）", () => {
  // 平铺降级线 fake：无 cdp，每帧快照 evaluate 按次序返回帧序列（最后一帧重复返回）
  function frameView(frames: Record<string, unknown>[]): WebViewLike {
    let i = 0;
    return {
      url: "about:blank",
      title: "",
      loading: false,
      async navigate() {},
      async evaluate(script: string) {
        if (!script.includes("wa-snapshot")) return script;
        return frames[Math.min(i++, frames.length - 1)];
      },
      async click() {},
      async type() {},
      async press() {},
      async scroll() {},
      async scrollTo() {},
      async screenshot() {
        return Buffer.from([0]);
      },
      close() {},
    } as unknown as WebViewLike;
  }

  /** AX 线 fake：getFullAXTree 按次序返回节点帧序列（最后一帧重复返回） */
  function axFrameView(frames: AXNode[][], opts: { failFrom?: number } = {}): WebViewLike {
    let i = 0;
    return {
      url: "about:blank",
      title: "",
      loading: false,
      async navigate() {},
      async evaluate(script: string) {
        if (script.includes("wa-snapshot")) throw new Error("不应走平铺线");
        return [];
      },
      async cdp(method: string) {
        if (opts.failFrom !== undefined && i >= opts.failFrom) throw new Error("cdp boom");
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "u-1" } } };
        if (method === "Accessibility.getFullAXTree") {
          return { nodes: frames[Math.min(i++, frames.length - 1)] };
        }
        return {};
      },
      async click() {},
      async type() {},
      async press() {},
      async scroll() {},
      async scrollTo() {},
      async screenshot() {
        return Buffer.from([0]);
      },
      close() {},
    } as unknown as WebViewLike;
  }

  const A = { "@1": { n: 1, tag: "button", label: "a", x: 1, y: 1 } };
  const B = { "@1": { n: 1, tag: "button", label: "b", x: 1, y: 1 } };
  const OPTS = { intervalMs: 1, maxFrames: 4 };

  // —— 平铺降级线（无 cdp fake）：行为不变 ——
  test("[平铺线] 相邻两帧一致 → 立即稳定返回该帧", async () => {
    const r = await captureStableSnapshot(frameView([A, A]), OPTS);
    expect(r.text).toContain('"a"');
    expect(r.selectorMap).toBeUndefined();
  });

  test("[平铺线] 渲染中逐帧变化 → 取到一致的那帧", async () => {
    const r = await captureStableSnapshot(frameView([A, B, B]), OPTS);
    expect(r.text).toContain('"b"');
  });

  test("[平铺线] 持续变化超帧数预算 → 取末帧降级（不报错）", async () => {
    const r = await captureStableSnapshot(frameView([A, B, A, B, A]), {
      intervalMs: 1,
      maxFrames: 4,
    });
    expect(r.text).toContain('"b"');
  });

  test("[平铺线] 单帧也成立（页面已静止）", async () => {
    const r = await captureStableSnapshot(frameView([B]), {
      intervalMs: 1,
      maxFrames: 4,
    });
    expect(r.text).toContain('"b"');
  });

  test("[平铺线] requireNonEmpty：空帧不算稳定，继续等到有内容帧", async () => {
    // SPA 场景：load 后 Vue 未挂载前连续空帧，不应被判稳定提前返回
    const EMPTY = {};
    const r = await captureStableSnapshot(frameView([EMPTY, EMPTY, A, A]), {
      intervalMs: 1,
      maxFrames: 4,
      requireNonEmpty: true,
    });
    expect(r.text).toContain('"a"');
  });

  test("[平铺线] requireNonEmpty：预算内始终为空 → 降级返回空帧（不报错）", async () => {
    const EMPTY = {};
    const r = await captureStableSnapshot(frameView([EMPTY]), {
      intervalMs: 1,
      maxFrames: 2,
      requireNonEmpty: true,
    });
    expect(r.text).toBe("");
    expect(r.framesValid).toBeGreaterThan(0); // 空对象也是有效快照（真空白页）
  });

  // —— AX 线（cdp fake）——
  const AX_A: AXNode[] = [
    { nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] },
    { nodeId: "2", role: { type: "role", value: "button" }, name: { type: "computedString", value: "甲" }, backendDOMNodeId: 11 },
  ];
  const AX_B: AXNode[] = [
    { nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] },
    { nodeId: "2", role: { type: "role", value: "button" }, name: { type: "computedString", value: "乙" }, backendDOMNodeId: 12 },
  ];

  test("[AX 线] 双帧一致即返回，带 selectorMap（ref→role/name）", async () => {
    const r = await captureStableSnapshot(axFrameView([AX_A, AX_A]), OPTS);
    expect(r.text).toContain('- button "甲" [ref=11]');
    expect(r.selectorMap?.[11]).toStrictEqual({ role: "button", name: "甲" });
  });

  test("[AX 线] requireNonEmpty：仅根节点（空树）不算稳定，继续等到有内容帧", async () => {
    const ROOT_ONLY: AXNode[] = [
      { nodeId: "1", role: { type: "role", value: "RootWebArea" } },
    ];
    const r = await captureStableSnapshot(axFrameView([ROOT_ONLY, ROOT_ONLY, AX_B, AX_B]), {
      intervalMs: 1,
      maxFrames: 4,
      requireNonEmpty: true,
    });
    expect(r.text).toContain('"乙"');
  });

  test("[AX 线] cdp 中途抛错 → 降级平铺线继续抓帧（不报错）", async () => {
    // 第 2 帧起 cdp 抛错：第 1 帧 AX 文本（乙树），后续平铺线 refs 帧 → 文本含 "a"
    const view = axFrameView([AX_A, AX_A], { failFrom: 1 });
    const withFlat = view as unknown as {
      evaluate: (s: string) => Promise<unknown>;
    };
    // 降级后 evaluate 走平铺帧：改写 evaluate 逻辑——首个 wa-snapshot 帧返 A
    let flatCalls = 0;
    withFlat.evaluate = async (s: string) => {
      if (s.includes("wa-snapshot")) {
        flatCalls++;
        return flatCalls === 1 ? A : A;
      }
      return [];
    };
    const r = await captureStableSnapshot(view, { intervalMs: 1, maxFrames: 3 });
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.framesValid).toBeGreaterThan(0);
  });
});

describe("diffSnapshotLines 差值标记", () => {
  const prev = '@1 button "登 录"\n@2 textbox "手机号" = ""';

  test("无基准（首次）→ 原样不打星", () => {
    expect(diffSnapshotLines(undefined, prev)).toBe(prev);
  });

  test("新增行打星，旧行保持原样", () => {
    const next = `${prev}\n@3 button "搜索"`;
    const out = diffSnapshotLines(prev, next);
    expect(out).toContain('* @3 button "搜索"');
    expect(out.split("\n")).toContain('@1 button "登 录"'); // 无星
  });

  test("值变化的行视为新行打星", () => {
    const next = prev.replace('= ""', '= "132"');
    const out = diffSnapshotLines(prev, next);
    expect(out).toContain('* @2 textbox "手机号" = "132"');
    expect(out.split("\n")).toContain('@1 button "登 录"'); // 无星
  });

  test("完全相同 → 原样无星（外层应走 unchanged 分支）", () => {
    expect(diffSnapshotLines(prev, prev)).toBe(prev);
  });
});

describe("clickTextScript 文本定位脚本", () => {
  test("合法 JS；目标文本经 JSON 转义嵌入（防注入）", () => {
    const evil = '"); alert(1); ("';
    const s = clickTextScript(evil);
    expect(() => new Function(s)).not.toThrow();
    expect(s).toContain("wa-click-text"); // fake/测试识别标记
    expect(s).not.toContain('alert(1); ("');
  });

  test("脚本含文本匹配、可见性过滤与最深匹配语义", () => {
    const s = clickTextScript("盘点完成");
    expect(s).toContain("盘点完成");
    expect(s).toContain("getBoundingClientRect");
    expect(s).toContain("scrollIntoView");
    // 反向遍历取最深匹配（避免命中含同文本的父容器）
    expect(s).toContain("i--");
  });
});

describe("hoverLocateScript 悬停定位脚本", () => {
  test("合法 JS；文本经 JSON 转义；含 selector 与文本两种模式", () => {
    const byText = hoverLocateScript({ text: "库存" });
    expect(() => new Function(byText)).not.toThrow();
    expect(byText).toContain("wa-hover");
    expect(byText).toContain("库存");
    const bySel = hoverLocateScript({ selector: "#dd" });
    expect(() => new Function(bySel)).not.toThrow();
    expect(bySel).toContain("#dd");
  });

  test("恶意文本被 JSON 转义（防注入）", () => {
    const s = hoverLocateScript({ text: '"); alert(1); ("' });
    expect(() => new Function(s)).not.toThrow();
    expect(s).not.toContain('alert(1); ("');
  });
});

describe("clickTextScript 与 hover 元素集合一致性", () => {
  test("click text 集合含 menu/tab/dropdown/btn 启发式（与 hover 对齐）", () => {
    const s = clickTextScript("盘点");
    expect(s).toContain('[class*="menu"]');
    expect(s).toContain('[class*="tab"]');
    expect(s).toContain('[class*="dropdown"]');
    expect(s).toContain('[class*="btn"]');
    // 启发式集合是文档序追加、反向遍历仍取最深匹配
    expect(s).toContain("i--");
  });
});

describe("clickTextScript 容器下钻", () => {
  test("命中元素后向下钻取包含文本的最深后代（防容器误点）", () => {
    const s = clickTextScript("库存");
    // 下钻循环：命中容器后沿 children 找仍包含目标的更深后代
    expect(s).toContain("deeper");
    expect(s).toContain("children");
  });
});

describe("clickTextScript 全半角归一化", () => {
  test("查询与元素文本都做全半角括号归一化后再匹配", () => {
    const s = clickTextScript("化骨贴(大)");
    // 归一化函数：全角括号 → 半角
    expect(s).toContain("normalize");
  });
});

describe("clickTextScript 全 DOM 兜底", () => {
  test("启发式集合未命中时兜底全 DOM 反向最深匹配（覆盖分类树等自绘节点）", () => {
    const s = clickTextScript("头疗单品");
    // 兜底段：body * 全量反向遍历（文档序后代在后 → 反向先遇最深）
    expect(s).toContain("body *");
    // 兜底在启发式之后（兜底段出现在主循环之后）
    const mainIdx = s.indexOf("for (let i = els.length");
    const fallbackIdx = s.indexOf("body *");
    expect(mainIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(mainIdx);
  });
});

describe("occlusionProbeScript 点击前遮挡校验脚本", () => {
  test("合法 JS 且为自执行 IIFE，含 elementFromPoint 与 wa-occlusion 标记", () => {
    const s = occlusionProbeScript({ x: 10, y: 20, targetText: "按钮" });
    expect(() => new Function(s)).not.toThrow();
    expect(s.trimEnd().endsWith("})()")).toBe(true);
    expect(s).toContain("wa-occlusion");
    expect(s).toContain("elementFromPoint");
    // 禁止反引号与 ${（外层 TS 模板字符串转义约束，与 ANNOTATE_SCRIPT 同规）
    expect(s).not.toContain("`");
    expect(s).not.toContain("${");
  });

  test("两种目标描述的嵌入形态：selector 原样嵌入、text JSON 转义（data-wa-ref 模式已退役）", () => {
    const sel = occlusionProbeScript({ targetSelector: 'div.a"b' }); // 含引号的 selector 也必须安全嵌入
    expect(() => new Function(sel)).not.toThrow();
    expect(sel).toContain("querySelector");
    const text = occlusionProbeScript({ x: 1, y: 2, targetText: "确认</script>" });
    expect(() => new Function(text)).not.toThrow();
    expect(occlusionProbeScript({})).toContain("occluded: false"); // 无目标描述 → 放行
  });

  test("不再支持 data-wa-ref 目标模式（click ref 已改坐标+文本近似）", () => {
    const s = occlusionProbeScript({ x: 10, y: 20, targetText: "登录" });
    expect(s).not.toContain("data-wa-ref");
  });

  test("非有限坐标按缺省处理（脚本内 px/py null 防御放行）", () => {
    const s = occlusionProbeScript({ x: Number.NaN, y: Number.POSITIVE_INFINITY, targetText: "x" });
    expect(() => new Function(s)).not.toThrow();
    expect(s).toContain("null");
  });

  test("ref 场景传 role：输入类目标命中表单控件 → 含语义放行分支（百度 textarea 误报修复）", () => {
    // 背景：AX name 可能来自 wrapper 的 aria-label（百度搜索框 AX name 是热搜词），
    // 探针在 textarea 上读不到该文本 → 误报遮挡卡死 ref 工作流。目标为输入类 role
    // 且中心命中表单控件（自身或后代）时视为目标本身放行。
    const s = occlusionProbeScript({ x: 10, y: 20, targetText: "网友称…", role: "textbox" });
    expect(() => new Function(s)).not.toThrow();
    expect(s).toContain('"textbox"'); // role 经 JSON 转义嵌入
    expect(s).toContain("FORM_ROLES");
    expect(s).toContain("isFormControl");
    // 不传 role：不嵌入角色变量值（TEXT 判断行为不变）
    const noRole = occlusionProbeScript({ x: 10, y: 20, targetText: "登录" });
    expect(noRole).toContain("const ROLE = null");
  });
});

describe("captureStableSnapshot AX 线 describeNode 收敛（Frame/Finalize 拆分）", () => {
  /** 计数 fake：AX 节点帧序列 + probe 返回 pointers，记录全部 cdp 调用与 probe evaluate 次数 */
  function axCountingView(
    frames: AXNode[][],
    pointers: { text: string }[],
    opts: { nodeIds?: number[]; backendIds?: number[] } = {},
  ): WebViewLike & {
    calls: { method: string }[];
    probeEvals: number;
  } {
    let i = 0;
    const calls: { method: string }[] = [];
    const view = {
      calls,
      probeEvals: 0,
      url: "about:blank",
      title: "",
      loading: false,
      async navigate() {},
      async evaluate(script: string) {
        if (script.includes("data-wa-ptr")) {
          view.probeEvals++;
          return pointers;
        }
        throw new Error("不应走平铺线");
      },
      async cdp(method: string, params?: Record<string, unknown>) {
        calls.push({ method });
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "u-1" } } };
        if (method === "Accessibility.getFullAXTree") {
          return { nodes: frames[Math.min(i++, frames.length - 1)] };
        }
        if (method === "DOM.getDocument") return { root: { nodeId: 5 } };
        if (method === "DOM.querySelectorAll") return { nodeIds: opts.nodeIds ?? [] };
        if (method === "DOM.describeNode") {
          const requested = Number(params?.nodeId ?? -1);
          const pos = (opts.nodeIds ?? []).indexOf(requested);
          return {
            node: { backendNodeId: pos >= 0 ? (opts.backendIds?.[pos] ?? requested) : requested },
          };
        }
        return {};
      },
      async click() {},
      async type() {},
      async press() {},
      async scroll() {},
      async scrollTo() {},
      async screenshot() {
        return Buffer.from([0]);
      },
      close() {},
    };
    return view as unknown as WebViewLike & { calls: { method: string }[]; probeEvals: number };
  }

  /** 三帧一致的 AX 树（含一个可点 button） */
  const STABLE: AXNode[] = [
    { nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2", "3"] },
    { nodeId: "2", role: { type: "role", value: "button" }, name: { type: "computedString", value: "甲" }, backendDOMNodeId: 11 },
    { nodeId: "3", role: { type: "role", value: "button" }, name: { type: "computedString", value: "乙" }, backendDOMNodeId: 12 },
  ];

  test("T1: 三帧一致 + probe 命中 3 元素 → describeNode 恰 3 次（出口 1×3），getDocument/querySelectorAll 各恰 1 次", async () => {
    const view = axCountingView([STABLE, STABLE, STABLE], [{ text: "卡1" }, { text: "卡2" }, { text: "卡3" }], {
      nodeIds: [100, 101, 102],
      backendIds: [201, 202, 203],
    });
    const r = await captureStableSnapshot(view, { intervalMs: 1, maxFrames: 4 });
    expect(r.text).toContain("(pointer)");
    const count = (m: string) => view.calls.filter((c) => c.method === m).length;
    expect(count("DOM.describeNode")).toBe(3);
    expect(count("DOM.getDocument")).toBe(1);
    expect(count("DOM.querySelectorAll")).toBe(1);
  });

  test("T3: probe 命中 0 跑多帧 → CDP 解析链零调用，probe evaluate 每帧照跑，文本为纯 AX 主体", async () => {
    const view = axCountingView([STABLE, STABLE, STABLE], []);
    const r = await captureStableSnapshot(view, { intervalMs: 1, maxFrames: 3 });
    const count = (m: string) => view.calls.filter((c) => c.method === m).length;
    expect(count("DOM.describeNode")).toBe(0);
    expect(count("DOM.getDocument")).toBe(0);
    expect(count("DOM.querySelectorAll")).toBe(0);
    expect(view.probeEvals).toBe(2); // 第 2 帧即稳定早退（双帧一致），共跑 2 帧
    expect(r.text).toBe('- button "甲" [ref=11]\n- button "乙" [ref=12]');
    expect(r.text).not.toContain("(pointer)");
  });

  test("T4: 帧持续变化跑满 maxFrames → 返回末帧完整文本（含 [ref] (pointer)），describeNode 仅末帧一次", async () => {
    const mk = (n: string, id: number): AXNode[] => [
      { nodeId: "1", role: { type: "role", value: "RootWebArea" }, childIds: ["2"] },
      { nodeId: "2", role: { type: "role", value: "button" }, name: { type: "computedString", value: n }, backendDOMNodeId: id },
    ];
    const view = axCountingView(
      [mk("a", 11), mk("b", 12), mk("c", 13), mk("d", 14)],
      [{ text: "自绘件" }],
      { nodeIds: [100], backendIds: [999] },
    );
    const r = await captureStableSnapshot(view, { intervalMs: 1, maxFrames: 4 });
    expect(r.text).toContain('- button "d" [ref=14]');
    expect(r.text).toContain('- generic "自绘件" [ref=999] (pointer)');
    expect(r.selectorMap?.[999]).toStrictEqual({ role: "generic", name: "自绘件" });
    expect(view.calls.filter((c) => c.method === "DOM.describeNode").length).toBe(1);
  });

  test("T5: describeNode 链抛错 → 出口返回纯 AX 主体文本，不抛错", async () => {
    const view = axCountingView([STABLE, STABLE], [{ text: "卡1" }], { nodeIds: [100] });
    // 劫持 describeNode 抛错
    const v = view as unknown as {
      cdp: (m: string, p?: Record<string, unknown>) => Promise<unknown>;
    };
    const orig = v.cdp.bind(v);
    v.cdp = async (m, p) => {
      if (m === "DOM.describeNode") throw new Error("describe boom");
      return orig(m, p);
    };
    const r = await captureStableSnapshot(view, { intervalMs: 1, maxFrames: 4 });
    expect(r.text).toBe('- button "甲" [ref=11]\n- button "乙" [ref=12]');
    expect(r.text).not.toContain("(pointer)");
  });

  test("T8: settled 返回的 selectorMap 含 pointer 强制 ref 增补（refCount 口径不变）", async () => {
    // probe backendId=12 命中 AX 树 button「乙」→ 强制 ref 并标 (pointer)，selectorMap 增补
    const view = axCountingView([STABLE, STABLE], [{ text: "乙" }], {
      nodeIds: [100],
      backendIds: [12],
    });
    const r = await captureStableSnapshot(view, { intervalMs: 1, maxFrames: 4 });
    expect(r.text).toContain('- button "乙" [ref=12] (pointer)');
    expect(r.selectorMap?.[11]).toStrictEqual({ role: "button", name: "甲" });
    expect(r.selectorMap?.[12]).toStrictEqual({ role: "button", name: "乙" });
  });
});
