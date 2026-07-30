// explorer store 测试：toggle/setOpen 行为 + localStorage 持久化。
import { test, expect, beforeEach } from "bun:test";
import { useExplorerStore } from "../src/store/explorer";

beforeEach(() => {
  localStorage.clear();
  // 重置 store 到初始态（从未持久化）
  useExplorerStore.setState({ open: false });
});

test("初始 open 为 false（localStorage 无记录）", () => {
  expect(useExplorerStore.getState().open).toBe(false);
});

test("toggle 切换 open 并持久化到 localStorage", () => {
  useExplorerStore.getState().toggle();
  expect(useExplorerStore.getState().open).toBe(true);
  expect(localStorage.getItem("wa-pi:explorer-open")).toBe("1");

  useExplorerStore.getState().toggle();
  expect(useExplorerStore.getState().open).toBe(false);
  expect(localStorage.getItem("wa-pi:explorer-open")).toBe("0");
});

test("setOpen 直接设置并持久化", () => {
  useExplorerStore.getState().setOpen(true);
  expect(useExplorerStore.getState().open).toBe(true);
  expect(localStorage.getItem("wa-pi:explorer-open")).toBe("1");
});
