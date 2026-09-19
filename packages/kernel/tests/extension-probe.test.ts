// packages/kernel/tests/extension-probe.test.ts
// 冲突判定纯函数单测（探测本身依赖真实 pi 进程，由 ws-extension-conflict 集成测试覆盖）。
import { test, expect } from "bun:test";
import { findConflictsFor } from "../src/extension-probe";

test("同名命令归属多个包且含目标包 → 报冲突", () => {
  const byName = new Map<string, Set<string>>([
    ["goal", new Set(["pi-goal-x", "@narumitw/pi-goal"])],
    ["sisyphus", new Set(["pi-goal-x"])],
  ]);
  expect(findConflictsFor(byName, "@narumitw/pi-goal")).toEqual([
    { name: "goal", packages: ["pi-goal-x", "@narumitw/pi-goal"] },
  ]);
});

test("只报涉及目标包的冲突：两个已装插件互撞不阻碍装第三个无关插件", () => {
  const byName = new Map<string, Set<string>>([
    ["legacy", new Set(["pkg-a", "pkg-b"])],
  ]);
  expect(findConflictsFor(byName, "pkg-c")).toEqual([]);
});

test("单包独占的命令不算冲突", () => {
  const byName = new Map<string, Set<string>>([["mine", new Set(["pkg-a"])]]);
  expect(findConflictsFor(byName, "pkg-a")).toEqual([]);
});

test("空注册表返回空", () => {
  expect(findConflictsFor(new Map(), "pkg-a")).toEqual([]);
});
