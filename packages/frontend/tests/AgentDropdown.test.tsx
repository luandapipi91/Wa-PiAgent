import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentDropdown } from "../src/components/ui/AgentDropdown";
import { useAgentsStore } from "../src/store/agents";
import type { AgentConfig } from "@wa-pi/shared";

const cfg = (name: string): AgentConfig => ({
  displayName: name, avatar: "🤖", avatarColor: "#06b6d4-#3b82f6",
  description: `${name}简介`, model: "m", thinking: "disabled",
  systemPromptMode: "replace",
  tools: [], skills: [], mcpServers: [], partners: { askTo: [] },
});

beforeEach(() => {
  useAgentsStore.setState({ list: [cfg("dev"), cfg("代码审查"), cfg("质量验收")] });
});

test("显示当前选中智能体，点击展开带搜索框的列表", () => {
  render(<AgentDropdown agents={useAgentsStore.getState().list} value="dev" onPick={() => {}} />);
  expect(screen.getByTestId("agent-select")).toBeTruthy();
  fireEvent.click(screen.getByTestId("agent-select"));
  expect(screen.getByTestId("agent-search")).toBeTruthy();
  expect(screen.getByTestId("agent-item-代码审查")).toBeTruthy();
});

test("搜索框过滤智能体列表", () => {
  render(<AgentDropdown agents={useAgentsStore.getState().list} value="dev" onPick={() => {}} />);
  fireEvent.click(screen.getByTestId("agent-select"));
  fireEvent.change(screen.getByTestId("agent-search"), { target: { value: "验收" } });
  expect(screen.queryByTestId("agent-item-代码审查")).toBeNull();
  expect(screen.getByTestId("agent-item-质量验收")).toBeTruthy();
});

test("选中非当前项立即触发 onPick（无确认框）", () => {
  let picked = "";
  render(<AgentDropdown agents={useAgentsStore.getState().list} value="dev" onPick={n => { picked = n; }} />);
  fireEvent.click(screen.getByTestId("agent-select"));
  fireEvent.click(screen.getByTestId("agent-item-代码审查"));
  expect(picked).toBe("代码审查");
  // 选中后下拉关闭
  expect(screen.queryByTestId("agent-search")).toBeNull();
});

test("选中当前项也触发关闭但不重复 onPick", () => {
  let pickCount = 0;
  render(<AgentDropdown agents={useAgentsStore.getState().list} value="dev" onPick={() => { pickCount++; }} />);
  fireEvent.click(screen.getByTestId("agent-select"));
  fireEvent.click(screen.getByTestId("agent-item-dev"));
  expect(pickCount).toBe(0);
  expect(screen.queryByTestId("agent-search")).toBeNull();
});

test("missing=true 时 pill 显示警示态", () => {
  render(<AgentDropdown agents={useAgentsStore.getState().list} value="已删除者" onPick={() => {}} missing />);
  expect(screen.getByTestId("agent-missing")).toBeTruthy();
  // 警示态点击仍可展开
  fireEvent.click(screen.getByTestId("agent-select"));
  expect(screen.getByTestId("agent-search")).toBeTruthy();
});

test("点击组件外部关闭下拉", () => {
  render(<AgentDropdown agents={useAgentsStore.getState().list} value="dev" onPick={() => {}} />);
  fireEvent.click(screen.getByTestId("agent-select"));
  expect(screen.getByTestId("agent-search")).toBeTruthy();
  // 模拟点击外部
  fireEvent.mouseDown(document.body);
  expect(screen.queryByTestId("agent-search")).toBeNull();
});

test("搜索按 displayName 过滤（用户可见名称）", () => {
  const agents = [cfg("技术实现"), cfg("项目管理")];
  render(<AgentDropdown agents={agents} value="技术实现" onPick={() => {}} />);
  fireEvent.click(screen.getByTestId("agent-select"));
  fireEvent.change(screen.getByTestId("agent-search"), { target: { value: "技术" } });
  expect(screen.getByTestId("agent-item-技术实现")).toBeTruthy();
  expect(screen.queryByTestId("agent-item-项目管理")).toBeNull();
});

test("agents 为空时下拉显示无智能体", () => {
  render(<AgentDropdown agents={[]} value={null} onPick={() => {}} />);
  fireEvent.click(screen.getByTestId("agent-select"));
  expect(screen.getByText(/无智能体/)).toBeTruthy();
});
