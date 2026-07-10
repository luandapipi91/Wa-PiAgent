import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProviderFormModal } from "../src/components/settings/ProviderFormModal";
import { useProvidersStore } from "../src/store/providers";

beforeEach(() => {
  useProvidersStore.setState(useProvidersStore.getInitialState(), true);
});

test("渲染表单字段", () => {
  render(<ProviderFormModal onClose={() => {}} />);
  expect(screen.getByText("供应商名称")).toBeTruthy();
  expect(screen.getByText("Base URL")).toBeTruthy();
  expect(screen.getByText("API Key")).toBeTruthy();
  expect(screen.getByText("API 格式")).toBeTruthy();
  expect(screen.getByText(/模型 ID/)).toBeTruthy();
});

test("必填为空时保存按钮禁用", () => {
  render(<ProviderFormModal onClose={() => {}} />);
  const saveBtn = screen.getByTestId("provider-save-btn") as HTMLButtonElement;
  expect(saveBtn.disabled).toBe(true);
});

test("填写完整 + 添加模型后保存启用", () => {
  render(<ProviderFormModal onClose={() => {}} />);
  fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByTestId("field-baseUrl"), { target: { value: "https://api.test.com/v1" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  // 输入模型 id
  const tagInput = screen.getByTestId("tag-input-field");
  fireEvent.change(tagInput, { target: { value: "model-1|" } });
  const saveBtn = screen.getByTestId("provider-save-btn") as HTMLButtonElement;
  expect(saveBtn.disabled).toBe(false);
});

test("tag 添加后模型表格出现行", () => {
  render(<ProviderFormModal onClose={() => {}} />);
  // 先填必填
  fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByTestId("field-baseUrl"), { target: { value: "https://api.test.com/v1" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "model-1|" } });
  // 表格出现该模型 id（tag 芯片也显示同名文本，用 getAllByText 容忍多个匹配）
  const matches = screen.getAllByText("model-1");
  expect(matches.length).toBeGreaterThanOrEqual(1);
  // 上下文窗口/最大输出输入框存在
  expect(screen.getByTestId("model-contextWindow-0")).toBeTruthy();
  expect(screen.getByTestId("model-maxTokens-0")).toBeTruthy();
});

test("编辑模式预填 initial 值", () => {
  render(
    <ProviderFormModal
      initial={{
        id: "p1", name: "Existing", baseUrl: "https://api.existing.com/v1",
        apiKey: "sk-existing", api: "openai-completions",
        models: [{ id: "existing-model", contextWindow: 32000, maxTokens: 4096 }],
      }}
      onClose={() => {}}
    />
  );
  expect((screen.getByTestId("field-name") as HTMLInputElement).value).toBe("Existing");
  expect((screen.getByTestId("field-baseUrl") as HTMLInputElement).value).toBe("https://api.existing.com/v1");
});

test("保存调用 store.save", () => {
  const saveMock = mock();
  useProvidersStore.setState({ save: saveMock });
  render(<ProviderFormModal onClose={() => {}} />);
  fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByTestId("field-baseUrl"), { target: { value: "https://api.test.com/v1" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "m1|" } });
  fireEvent.click(screen.getByTestId("provider-save-btn"));
  expect(saveMock).toHaveBeenCalledTimes(1);
  const saved = saveMock.mock.calls[0][0];
  expect(saved.name).toBe("Test");
  expect(saved.models[0].id).toBe("m1");
});

test("添加模型后显示 supportsVision 开关并影响保存数据", () => {
  const saveMock = mock();
  useProvidersStore.setState({ save: saveMock });
  render(<ProviderFormModal onClose={() => {}} />);

  fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByTestId("field-baseUrl"), { target: { value: "https://api.test.com/v1" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "gpt-4o|" } });

  const visionCheckbox = screen.getByTestId("model-vision-0") as HTMLInputElement;
  expect(visionCheckbox).toBeTruthy();
  expect(visionCheckbox.checked).toBe(false);

  fireEvent.click(visionCheckbox);
  expect(visionCheckbox.checked).toBe(true);

  fireEvent.click(screen.getByTestId("provider-save-btn"));
  const saved = saveMock.mock.calls[0][0];
  expect(saved.models[0].supportsVision).toBe(true);
});
