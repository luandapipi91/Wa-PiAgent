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

test("默认停在第 1 步（主题选择），未选时「下一步」禁用", async () => {
  render(<OnboardingWizard onClose={() => {}} />);
  expect(await screen.findByTestId("wizard-step-1")).toBeTruthy();
  expect(screen.getByTestId("theme-card-newspaper")).toBeTruthy();
  expect((screen.getByTestId("wizard-next") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByTestId("wizard-step-2")).toBeNull();
});

test("选中主题后才能「下一步」，且写入 store", async () => {
  render(<OnboardingWizard onClose={() => {}} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("theme-card-newspaper"));
  const next = screen.getByTestId("wizard-next") as HTMLButtonElement;
  expect(next.disabled).toBe(false);
  fireEvent.click(next);
  expect(useUiPrefsStore.getState().themeMode).toBe("newspaper");
  expect(await screen.findByTestId("wizard-step-2")).toBeTruthy();
});

test("步骤条显示共三步", async () => {
  render(<OnboardingWizard onClose={() => {}} />);
  await screen.findByTestId("wizard-step-1");
  expect(screen.getByTestId("wizard-step-indicator").textContent).toContain("3");
});

test("不保存模型也能「下一步」从第 2 步进入第 3 步", async () => {
  render(<OnboardingWizard onClose={() => {}} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("theme-card-light"));
  fireEvent.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-2");
  fireEvent.click(screen.getByTestId("wizard-next"));
  expect(await screen.findByTestId("wizard-step-3")).toBeTruthy();
  expect(screen.getByTestId("agent-create-picker")).toBeTruthy();
});

test("保存模型供应商成功后自动进入智能体步骤", async () => {
  render(<OnboardingWizard onClose={() => {}} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("theme-card-dark"));
  fireEvent.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-2");
  fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByTestId("field-baseUrl"), { target: { value: "https://api.test.com/v1" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "model-1|" } });
  fireEvent.click(screen.getByTestId("provider-save-btn"));
  expect(await screen.findByTestId("wizard-step-3")).toBeTruthy();
  expect(screen.queryByTestId("wizard-step-2")).toBeNull();
});

test("「上一步」逐步回退", async () => {
  render(<OnboardingWizard onClose={() => {}} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("theme-card-pixel"));
  fireEvent.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-2");
  fireEvent.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-3");
  fireEvent.click(screen.getByTestId("wizard-back"));
  expect(await screen.findByTestId("wizard-step-2")).toBeTruthy();
  fireEvent.click(screen.getByTestId("wizard-back"));
  expect(await screen.findByTestId("wizard-step-1")).toBeTruthy();
});

test("最后一步「跳过」直接关闭", async () => {
  let closed = false;
  render(<OnboardingWizard onClose={() => { closed = true; }} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("theme-card-cyber"));
  fireEvent.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-2");
  fireEvent.click(screen.getByTestId("wizard-next"));
  fireEvent.click(await screen.findByTestId("wizard-skip"));
  expect(closed).toBe(true);
});

test("创建智能体成功后设为 defaultAgent 并关闭", async () => {
  let closed = false;
  postMock.mockImplementation(async () => ({ type: "agent:created", agent: {} }));
  render(<OnboardingWizard onClose={() => { closed = true; }} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("theme-card-system"));
  fireEvent.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-2");
  fireEvent.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-3");
  // 向导默认停在预设 Tab，先切到空白 Tab
  fireEvent.click(await screen.findByTestId("picker-tab-blank"));
  fireEvent.change(await screen.findByTestId("blank-name-input"), { target: { value: "林晓岚" } });
  fireEvent.click(screen.getByTestId("blank-create-btn"));
  await new Promise(r => setTimeout(r, 0));
  expect(useUiPrefsStore.getState().defaultAgent).toBe("林晓岚");
  expect(closed).toBe(true);
});

test("第 1 步选中主题后进入下一步，页面实际主题不被卸载回滚覆盖", async () => {
  render(<OnboardingWizard onClose={() => {}} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("theme-card-newspaper"));
  fireEvent.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-2");
  // store 已写入，且 <html data-theme> 必须与之一致（ThemePicker 卸载时不得回滚掉刚落库的主题）
  expect(useUiPrefsStore.getState().themeMode).toBe("newspaper");
  expect(document.documentElement.dataset.theme).toBe("newspaper");
});

test("向导关闭时记录主题引导已读，避免下次启动再以「老用户」身份弹一次", async () => {
  const { useUpdaterStore } = await import("../../store/updater");
  useUpdaterStore.setState({ appVersion: "0.10.5" } as any);
  useUiPrefsStore.setState({ themeIntroSeenVersion: undefined } as any);
  let closed = false;
  render(<OnboardingWizard onClose={() => { closed = true; }} />);
  await screen.findByTestId("wizard-step-1");
  fireEvent.click(screen.getByTestId("theme-card-dark"));
  fireEvent.click(screen.getByTestId("wizard-next"));
  await screen.findByTestId("wizard-step-2");
  fireEvent.click(screen.getByTestId("wizard-next"));
  fireEvent.click(await screen.findByTestId("wizard-skip"));
  expect(closed).toBe(true);
  expect(useUiPrefsStore.getState().themeIntroSeenVersion).toBe("0.10.5");
});
