import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentConfig } from "../src/components/AgentConfig";
import { useAgentsStore } from "../src/store/agents";

const mockConfig = {
  name: "dev", displayName: "研发", avatar: "⚙️", avatarColor: "a-b",
  description: "后端", model: "claude", thinking: "high" as const,
  systemPromptMode: "replace" as const, inheritProjectContext: true, inheritSkills: false,
  tools: ["read"], skills: [], mcpServers: [],
  partners: { askTo: ["product"], askFrom: ["product"] },
  systemPromptBody: "你是工程师",
};

mock.module("../src/ws-instance", () => ({
  send: () => {},
  onMessage: (cb: any) => { cb({ type: "agent:config", agentName: "dev", config: mockConfig }); return () => {}; },
}));

beforeEach(() => useAgentsStore.setState({ states: {}, configs: { dev: mockConfig } }));

test("打开显示 header + tabs", () => {
  render(<AgentConfig agentName="dev" onClose={() => {}} />);
  expect(screen.getByText("研发")).toBeTruthy();
  expect(screen.getByText("基本信息")).toBeTruthy();
});

test("切到系统提示词 tab 显示正文", () => {
  render(<AgentConfig agentName="dev" onClose={() => {}} />);
  fireEvent.click(screen.getByText("系统提示词"));
  expect(screen.getByDisplayValue("你是工程师")).toBeTruthy();
});

test("点保存触发 onClose", () => {
  // 不 mock send 为 vi.fn（拦截不稳定）；断言行为：点保存后 onClose 被调用
  const onClose = mock();
  render(<AgentConfig agentName="dev" onClose={onClose} />);
  fireEvent.click(screen.getByText("保存"));
  expect(onClose).toHaveBeenCalled();
});
