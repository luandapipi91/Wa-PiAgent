import { test, expect, vi, beforeEach } from "vitest";
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

vi.mock("../src/ws-instance", () => ({
  send: vi.fn(),
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

test("保存调 send", async () => {
  const { send } = await import("../src/ws-instance");
  (send as any).mockClear();
  const onClose = vi.fn();
  render(<AgentConfig agentName="dev" onClose={onClose} />);
  fireEvent.click(screen.getByText("保存"));
  expect(send).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});
