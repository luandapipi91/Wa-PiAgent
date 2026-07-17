import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SessionMessage } from "@hiagent/shared";
import { AgentListSection } from "../src/components/AgentListSection";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";

const s1 = { id: "s1", projectId: "p1", primaryAgent: "dev" as const, title: "t1", createdAt: 0, lastActivity: 0, piSessionFile: "" };

beforeEach(() => {
  useProjectsStore.setState({ projects: [], sessions: [] });
  useSessionStore.setState({ statusBySession: {}, messagesBySession: {} });
});

test("渲染 4 个 agent 行", () => {
  render(<AgentListSection onSelectAgent={() => {}} />);
  expect(screen.getByTestId("agent-dev")).toBeTruthy();
  expect(screen.getByTestId("agent-test")).toBeTruthy();
});

test("名下会话运行中时状态点显示靛蓝（thinking），无会话的 agent 保持空闲绿", () => {
  useProjectsStore.setState({ sessions: [s1] });
  useSessionStore.setState({ statusBySession: { s1: "thinking" } });
  render(<AgentListSection onSelectAgent={() => {}} />);
  // STATUS_COLORS.thinking 为 "#5B5BD6"（accent 靛蓝），浏览器 normalize 后通常为小写
  expect((screen.getByTestId("status-dev") as HTMLElement).style.background.toLowerCase()).toBe("#5b5bd6");
  expect((screen.getByTestId("status-test") as HTMLElement).style.background.toLowerCase()).toBe("#34a853");
});

test("名下会话有待回答提问时状态点显示警告橙（blocked 优先于 thinking）", () => {
  const askCall = { type: "toolCall", id: "tc-1", name: "ask_user_question", arguments: { questions: [{ question: "Q?", header: "h", options: [{ label: "A", description: "x" }] }] } };
  const messages: SessionMessage[] = [
    { agentName: "dev", message: { role: "assistant", content: [askCall], model: "m", stopReason: "tool_use", timestamp: 1 } as any },
  ];
  useProjectsStore.setState({ sessions: [s1] });
  useSessionStore.setState({ statusBySession: { s1: "thinking" }, messagesBySession: { s1: messages } });
  render(<AgentListSection onSelectAgent={() => {}} />);
  expect((screen.getByTestId("status-dev") as HTMLElement).style.background.toLowerCase()).toBe("#b45309");
});

test("点击触发 onSelectAgent", () => {
  const fn = mock();
  render(<AgentListSection onSelectAgent={fn} />);
  fireEvent.click(screen.getByTestId("agent-dev"));
  expect(fn).toHaveBeenCalledWith("dev");
});
