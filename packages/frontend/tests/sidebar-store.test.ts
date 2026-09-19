import { test, expect, beforeEach } from "bun:test";
import { useSidebarStore } from "../src/store/sidebar";

const STORAGE_KEY = "wa-pi-sidebar";

async function resetStore(): Promise<void> {
  localStorage.removeItem(STORAGE_KEY);
  useSidebarStore.setState({ width: 264 });
  await useSidebarStore.persist.rehydrate();
}

beforeEach(async () => {
  await resetStore();
});

test("默认宽度 264", () => {
  expect(useSidebarStore.getState().width).toBe(264);
});

test("setWidth 更新宽度", () => {
  useSidebarStore.getState().setWidth(300);
  expect(useSidebarStore.getState().width).toBe(300);
});

test("宽度持久化到 localStorage", () => {
  useSidebarStore.getState().setWidth(320);
  const raw = localStorage.getItem(STORAGE_KEY);
  expect(raw).not.toBeNull();
  const stored = JSON.parse(raw!);
  expect(stored.state.width).toBe(320);
});

test("从 localStorage 恢复宽度", async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { width: 280 }, version: 0 }));
  await useSidebarStore.persist.rehydrate();
  expect(useSidebarStore.getState().width).toBe(280);
});
