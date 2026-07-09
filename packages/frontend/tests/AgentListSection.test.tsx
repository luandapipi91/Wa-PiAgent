import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentListSection } from "../src/components/AgentListSection";
import { useAgentsStore } from "../src/store/agents";

beforeEach(() => useAgentsStore.setState({ states: {}, configs: {} }));

test("渲染 4 个 agent 行", () => {
  render(<AgentListSection onSelectAgent={() => {}} />);
  expect(screen.getByTestId("agent-dev")).toBeTruthy();
  expect(screen.getByTestId("agent-test")).toBeTruthy();
});

test("状态点反映全局聚合", () => {
  useAgentsStore.setState({
    states: { "p1:dev": { name: "dev", status: "thinking" } },
    configs: {},
  });
  render(<AgentListSection onSelectAgent={() => {}} />);
  const dot = screen.getByTestId("status-dev");
  expect((dot as HTMLElement).style.background).toBe("#5b5bd6"); // thinking 靛蓝
});

test("点击触发 onSelectAgent", () => {
  const fn = mock();
  render(<AgentListSection onSelectAgent={fn} />);
  fireEvent.click(screen.getByTestId("agent-dev"));
  expect(fn).toHaveBeenCalledWith("dev");
});
