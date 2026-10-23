import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { OnboardingWizard } from "./OnboardingWizard";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { useAgentsStore } from "../../store/agents";

const getMock = mock(); const postMock = mock();
mock.module("../../api-client", () => ({ api: { get: getMock, post: postMock, put: mock(), del: mock() } }));

beforeEach(() => {
  // 防御：全量（非 --isolate）运行时 clipboard.test.ts 会把 globalThis.window 换成 {}
  // 且不恢复，导致 Modal 的 window.addEventListener 崩溃；从 document.defaultView 还原
  if (typeof window.addEventListener !== "function" && (document as any).defaultView) {
    (globalThis as any).window = (document as any).defaultView;
  }
  getMock.mockReset(); postMock.mockReset();
  getMock.mockImplementation(async (path: string) =>
    path === "/api/agents/presets" ? { presets: [] } : { presets: [] });
  useUiPrefsStore.setState({ defaultAgent: null } as any);
  useAgentsStore.setState({ list: [] } as any);
});

test("默认停在第 1 步（模型表单）", async () => {
  render(<OnboardingWizard onClose={() => {}} />);
  expect(await screen.findByTestId("wizard-step-1")).toBeTruthy();
  expect(screen.queryByTestId("wizard-step-2")).toBeNull();
});

test("不保存模型也能「下一步」进入第 2 步", async () => {
  render(<OnboardingWizard onClose={() => {}} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("wizard-next"));
  expect(await screen.findByTestId("wizard-step-2")).toBeTruthy();
  expect(screen.getByTestId("agent-create-picker")).toBeTruthy();
});

test("第 2 步「上一步」返回第 1 步", async () => {
  render(<OnboardingWizard onClose={() => {}} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-2");
  fireEvent.click(screen.getByTestId("wizard-back"));
  expect(await screen.findByTestId("wizard-step-1")).toBeTruthy();
});

test("第 2 步「跳过」直接关闭", async () => {
  let closed = false;
  render(<OnboardingWizard onClose={() => { closed = true; }} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("wizard-next"));
  fireEvent.click(await screen.findByTestId("wizard-skip"));
  expect(closed).toBe(true);
});

test("创建智能体成功后设为 defaultAgent 并关闭", async () => {
  let closed = false;
  postMock.mockImplementation(async () => ({ type: "agent:created", agent: {} }));
  render(<OnboardingWizard onClose={() => { closed = true; }} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-2");
  // 向导默认停在预设 Tab，先切到空白 Tab
  fireEvent.click(await screen.findByTestId("picker-tab-blank"));
  fireEvent.change(await screen.findByTestId("blank-name-input"), { target: { value: "林晓岚" } });
  fireEvent.click(screen.getByTestId("blank-create-btn"));
  await new Promise(r => setTimeout(r, 0));
  expect(useUiPrefsStore.getState().defaultAgent).toBe("林晓岚");
  expect(closed).toBe(true);
});
