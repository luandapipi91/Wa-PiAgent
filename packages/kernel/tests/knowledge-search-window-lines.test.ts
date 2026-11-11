import { describe, test, expect } from "bun:test";
import {
  expandLineWindow,
  LINE_WINDOW_RADIUS,
  LINE_WINDOW_MAX_NEIGHBORS,
} from "../src/knowledge/search/window";

const row = (id: string, start: number, end: number, content = `L${start}`) => ({
  id,
  filePath: "/a.md",
  startLine: start,
  endLine: end,
  content,
  score: 0,
});

describe("adaptive 行窗扩展", () => {
  test("默认预算：±80 行、最多 5 邻居", () => {
    expect(LINE_WINDOW_RADIUS).toBe(80);
    expect(LINE_WINDOW_MAX_NEIGHBORS).toBe(5);
  });

  test("把 ±80 行内的邻居按原文顺序拼进来，行号取首尾", () => {
    const rows = [row("a", 1, 20), row("h", 100, 120), row("b", 150, 180), row("far", 400, 420)];
    const out = expandLineWindow(rows, rows[1]);
    expect(out.content).toBe("L1\nL100\nL150");
    expect(out.startLine).toBe(1);
    expect(out.endLine).toBe(180); // far 超出 80 行半径，未纳入
  });

  test("邻居超过 5 个时按距离取最近的 5 个", () => {
    const rows = [
      row("n1", 1, 10),
      row("n2", 20, 30),
      row("n3", 40, 50),
      row("h", 60, 70),
      row("n4", 80, 90),
      row("n5", 100, 110),
      row("n6", 120, 130),
    ];
    const out = expandLineWindow(rows, rows[3]);
    // 命中块 + 5 个邻居 = 6 段
    expect(out.content.split("\n").length).toBe(6);
    // 距离同为 50 的两端只有 1 个能进（另一个被挤出）
    const farEnds = ["L1", "L120"].filter((t) => out.content.split("\n").includes(t));
    expect(farEnds.length).toBe(1);
  });

  test("总字符超预算时丢弃更远的邻居，命中块本身永不丢", () => {
    const rows = [
      row("near", 1, 10, "x".repeat(100)),
      row("h", 20, 30, "h".repeat(5000)),
      row("far", 40, 50, "y".repeat(2000)),
    ];
    const out = expandLineWindow(rows, rows[1], { maxChars: 6000 });
    expect(out.content).toContain("h".repeat(5000));
    expect(out.content).toContain("x".repeat(100));
    expect(out.content).not.toContain("y".repeat(2000)); // 6000 预算放不下
  });

  test("同文件只有自己的块时原样返回", () => {
    const rows = [row("h", 10, 20, "only")];
    const out = expandLineWindow(rows, rows[0]);
    expect(out).toEqual({ content: "only", startLine: 10, endLine: 20 });
  });
});
