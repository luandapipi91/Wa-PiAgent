import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RecentSessionsList } from "../src/components/RecentSessionsList";
import { useProjectsStore } from "../src/store/projects";
import type { SessionEntity } from "@wa-pi/shared";

afterEach(() => cleanup());

beforeEach(() => {
  useProjectsStore.setState({
    projects: [
      { id: "__system__", name: "默认工作区", cwd: "", createdAt: 0 },
      { id: "p1", name: "HiAgent", cwd: "/a", createdAt: 0 },
    ],
    sessions: [
      { id: "s1", projectId: "p1", primaryAgent: "a", title: "侧边栏重构", createdAt: 0, lastActivity: Date.now() - 5000, piSessionFile: "" },
      { id: "s2", projectId: "__system__", primaryAgent: "a", title: "登录优化", createdAt: 0, lastActivity: Date.now() - 90000000, piSessionFile: "" },
    ],
    currentSessionId: "s1",
    currentProjectId: "p1",
  } as any);
});

test("渲染按天刻度分组 + 项目名标注 + 当前会话高亮选中", () => {
  const onSelect = () => {};
  render(<RecentSessionsList onSelectSession={onSelect} />);
  // 日期刻度
  expect(screen.getByText("今天")).toBeTruthy();
  // 「昨天」可能同时出现在 dayLabel 刻度与 SessionRow 右侧相对时间位（formatRelativeTime 对 24-48h 前返回「昨天」），用 getAllByText 消除歧义
  expect(screen.getAllByText("昨天").length).toBeGreaterThan(0);
  // 会话标题
  expect(screen.getByText("侧边栏重构")).toBeTruthy();
  expect(screen.getByText("登录优化")).toBeTruthy();
  // 项目名标注
  expect(screen.getByText("HiAgent")).toBeTruthy();
  expect(screen.getByText("默认工作区")).toBeTruthy();
  // 当前会话选中（SessionRow 选中态左条）
  const row = screen.getByTestId("session-s1") as HTMLButtonElement;
  expect(row.style.borderLeft).toContain("var(--accent)");
});

test("点击会话行调用 onSelectSession 且传会话 id", () => {
  const onSelect = (id: string) => { selectedId = id; };
  let selectedId = "";
  render(<RecentSessionsList onSelectSession={onSelect} />);
  fireEvent.click(screen.getByTestId("session-s2"));
  expect(selectedId).toBe("s2");
});

test("无会话时显示空态", () => {
  useProjectsStore.setState({ sessions: [] } as any);
  render(<RecentSessionsList onSelectSession={() => {}} />);
  expect(screen.getByTestId("recent-sessions-empty")).toBeTruthy();
});
