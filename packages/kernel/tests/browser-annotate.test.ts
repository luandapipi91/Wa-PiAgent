// browser-annotate.test.ts —— 标注注入脚本模块的单元测试（Layer 1）。
//
// ANNOTATE_SCRIPT / resolveRefScript 是要注入真实页面执行的 JS 字符串，
// 这里验证：脚本合法性（可被 new Function 解析）、关键行为标记（清除旧标注、
// scrollIntoView）、枚举上限常量，以及 resolveRefScript 对非法入参的防注入校验。
import { describe, expect, test } from "bun:test";
import type { WebViewLike } from "../src/browser-manager";
import {
  ANNOTATE_SCRIPT,
  INTERACTIVE_ROLE_SELECTOR,
  MAX_ANNOTATED_ELEMENTS,
  SNAPSHOT_SCRIPT,
  captureStableSnapshot,
  diffSnapshotLines,
  formatSnapshot,
  resolveRefScript,
} from "../src/browser-annotate";

describe("browser-annotate 注入脚本", () => {
  test("ANNOTATE_SCRIPT 是合法 JS 且为自执行 IIFE", () => {
    expect(() => new Function(ANNOTATE_SCRIPT)).not.toThrow();
    expect(ANNOTATE_SCRIPT.trimEnd().endsWith("})()")).toBe(true);
    // 禁止反引号与 ${（全局约束：外层用 TS 模板字符串包裹时不踩转义）
    expect(ANNOTATE_SCRIPT).not.toContain("`");
    expect(ANNOTATE_SCRIPT).not.toContain("${");
  });

  test("ANNOTATE_SCRIPT 先清除旧标注再枚举可交互元素", () => {
    expect(ANNOTATE_SCRIPT).toContain("data-wa-annotate");
    expect(ANNOTATE_SCRIPT).toContain("data-wa-ref");
    expect(ANNOTATE_SCRIPT).toContain("getBoundingClientRect");
  });

  test("ANNOTATE_SCRIPT 枚举上限为 MAX_ANNOTATED_ELEMENTS", () => {
    expect(ANNOTATE_SCRIPT).toContain("200");
    expect(MAX_ANNOTATED_ELEMENTS).toBe(200);
  });

  test("resolveRefScript 嵌入编号并先 scrollIntoView 再取中心", () => {
    const s = resolveRefScript(7);
    expect(() => new Function(s)).not.toThrow();
    expect(s).toContain('data-wa-ref="7"');
    expect(s).toContain("scrollIntoView");
    // 超宽元素也要水平居中，否则中心 x 可能落在视口外点空（审查 Minor #2）
    expect(s).toContain("inline");
  });

  test("resolveRefScript 拒绝非正整数（防脚本注入）", () => {
    expect(() => resolveRefScript(0)).toThrow();
    expect(() => resolveRefScript(-1)).toThrow();
    expect(() => resolveRefScript(1.5)).toThrow();
    expect(() => resolveRefScript(Number.NaN)).toThrow();
    expect(() => resolveRefScript(201)).toThrow();
  });
});

describe("SNAPSHOT_SCRIPT 文本快照注入脚本", () => {
  test("合法 JS 且为自执行 IIFE，产物无反引号/插值残留", () => {
    expect(() => new Function(SNAPSHOT_SCRIPT)).not.toThrow();
    expect(SNAPSHOT_SCRIPT.trimEnd().endsWith("})()")).toBe(true);
    expect(SNAPSHOT_SCRIPT).not.toContain("`");
    expect(SNAPSHOT_SCRIPT).not.toContain("${");
  });

  test("打 data-wa-ref 锚点供 click ref 复用，但不注入视觉 overlay", () => {
    expect(SNAPSHOT_SCRIPT).toContain("data-wa-ref");
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

describe("captureStableSnapshot 渲染稳定检测", () => {
  // fake view：每次快照 evaluate 按次序返回帧序列（最后一帧重复返回）
  function frameView(frames: Record<string, unknown>[]): WebViewLike {
    let i = 0;
    return {
      url: "about:blank",
      title: "",
      loading: false,
      async navigate() {},
      async evaluate(script: string) {
        if (!script.includes("data-wa-ref")) return script;
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
  const A = { "@1": { n: 1, tag: "button", label: "a", x: 1, y: 1 } };
  const B = { "@1": { n: 1, tag: "button", label: "b", x: 1, y: 1 } };
  const OPTS = { intervalMs: 1, maxFrames: 4 };

  test("相邻两帧一致 → 立即稳定返回该帧", async () => {
    const r = await captureStableSnapshot(frameView([A, A]), OPTS);
    expect(formatSnapshot(r.refs)).toContain('"a"');
  });

  test("渲染中逐帧变化 → 取到一致的那帧", async () => {
    const r = await captureStableSnapshot(frameView([A, B, B]), OPTS);
    expect(formatSnapshot(r.refs)).toContain('"b"');
  });

  test("持续变化超帧数预算 → 取末帧降级（不报错）", async () => {
    const r = await captureStableSnapshot(frameView([A, B, A, B, A]), {
      intervalMs: 1,
      maxFrames: 4,
    });
    expect(formatSnapshot(r.refs)).toContain('"b"');
  });

  test("单帧也成立（页面已静止）", async () => {
    const r = await captureStableSnapshot(frameView([B]), {
      intervalMs: 1,
      maxFrames: 4,
    });
    expect(formatSnapshot(r.refs)).toContain('"b"');
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
