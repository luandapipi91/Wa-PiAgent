import { test, expect, beforeEach } from "bun:test";
import { useProjectUiStore } from "../src/store/project-ui";

const STORAGE_KEY = "hiagent-project-ui";

async function resetStore(): Promise<void> {
  localStorage.removeItem(STORAGE_KEY);
  useProjectUiStore.setState({ collapsedProjectIds: [] });
  await useProjectUiStore.persist.rehydrate();
}

beforeEach(async () => {
  await resetStore();
});

test("项目默认展开", () => {
  expect(useProjectUiStore.getState().isExpanded("p1")).toBe(true);
});

test("toggleProject 折叠并再次展开项目", () => {
  const { toggleProject, isExpanded } = useProjectUiStore.getState();

  toggleProject("p1");
  expect(isExpanded("p1")).toBe(false);

  toggleProject("p1");
  expect(isExpanded("p1")).toBe(true);
});

test("setExpanded 显式设置展开状态", () => {
  const { setExpanded, isExpanded } = useProjectUiStore.getState();

  setExpanded("p1", false);
  expect(isExpanded("p1")).toBe(false);

  setExpanded("p1", true);
  expect(isExpanded("p1")).toBe(true);
});

test("折叠状态持久化到 localStorage", () => {
  useProjectUiStore.getState().toggleProject("p1");

  const raw = localStorage.getItem(STORAGE_KEY);
  expect(raw).not.toBeNull();
  const stored = JSON.parse(raw!);
  expect(stored.state.collapsedProjectIds).toEqual(["p1"]);
});

test("从 localStorage 恢复折叠状态", async () => {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ state: { collapsedProjectIds: ["p1"] }, version: 0 })
  );

  await useProjectUiStore.persist.rehydrate();

  expect(useProjectUiStore.getState().isExpanded("p1")).toBe(false);
  expect(useProjectUiStore.getState().isExpanded("p2")).toBe(true);
});
