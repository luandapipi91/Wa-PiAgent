import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AgentListSection } from "../src/components/AgentListSection";
import { useAgentsStore } from "../src/store/agents";

afterEach(() => cleanup());

test("渲染折叠栏：标题 + 数量角标 + 箭头", () => {
  useAgentsStore.setState({ list: [
    { displayName: "a1", avatar: "", avatarColor: "#4f46e5-#2563eb", description: "", model: null, thinking: null, tools: [], skills: [], mcpServers: [], partners: {} },
    { displayName: "a2", avatar: "", avatarColor: "#4f46e5-#2563eb", description: "", model: null, thinking: null, tools: [], skills: [], mcpServers: [], partners: {} },
  ] } as any);
  render(<AgentListSection onMore={() => {}} />);
  expect(screen.getByTestId("agent-collapsed")).toBeTruthy();
  expect(screen.getByText("智能体")).toBeTruthy();
  expect(screen.getByText("2")).toBeTruthy();
});

test("点击折叠栏调用 onMore，且不再渲染 top-3 列表", () => {
  // seed 非空 list：若旧的 top-3 列表逻辑仍存在，会渲染 agent-a1 / agent-more
  useAgentsStore.setState({ list: [
    { displayName: "a1", avatar: "", avatarColor: "#4f46e5-#2563eb", description: "", model: "m", thinking: "medium", tools: [], skills: [], mcpServers: [], partners: {} },
    { displayName: "a2", avatar: "", avatarColor: "#4f46e5-#2563eb", description: "", model: "m", thinking: "medium", tools: [], skills: [], mcpServers: [], partners: {} },
  ] } as any);
  const onMore = mock(() => {});
  render(<AgentListSection onMore={onMore} />);
  // 折叠栏取代 top-3 列表：折叠栏存在，列表项与「更多」入口均不渲染
  expect(screen.getByTestId("agent-collapsed")).toBeTruthy();
  expect(screen.queryByTestId("agent-a1")).toBeNull();
  expect(screen.queryByTestId("agent-more")).toBeNull();
  fireEvent.click(screen.getByTestId("agent-collapsed"));
  expect(onMore).toHaveBeenCalledTimes(1);
});
