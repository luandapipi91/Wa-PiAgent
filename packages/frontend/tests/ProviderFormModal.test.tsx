import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useProvidersStore } from "../src/store/providers";

// 全局 onMessage 回调收集器 — 由 mock 的 onMessage 写入
let onMsgCallback: ((e: any) => void) | null = null;

// Mock ws-instance：onMessage 注册回调，send 收集消息
mock.module("../src/ws-instance", () => {
  return {
    send(e: any) {
      // model:presets 请求 → 用预设数据回复
      if (e.type === "model:presets" && onMsgCallback) {
        onMsgCallback({
          type: "model:presets",
          presets: [
            {
              key: "deepseek",
              name: "DeepSeek",
              baseUrl: "https://api.deepseek.com",
              api: "openai-completions",
              models: [
                { id: "deepseek-chat", contextWindow: 128000, maxTokens: 8192, supportsVision: false },
                { id: "deepseek-reasoner", contextWindow: 128000, maxTokens: 32768, supportsVision: false },
              ],
            },
            {
              key: "anthropic",
              name: "Anthropic",
              baseUrl: "https://api.anthropic.com",
              api: "anthropic-messages",
              models: [
                { id: "claude-sonnet-5", contextWindow: 1000000, maxTokens: 128000, supportsVision: true },
                { id: "claude-opus-4-5", contextWindow: 200000, maxTokens: 32000, supportsVision: true },
              ],
            },
          ],
        });
      }
    },
    onMessage(h: (e: any) => void) {
      onMsgCallback = h;
      return () => { onMsgCallback = null; };
    },
  };
});

// mock 需要在 import 之前生效，所以把组件 import 放在 mock.module 之后
import { ProviderFormModal } from "../src/components/settings/ProviderFormModal";

beforeEach(() => {
  useProvidersStore.setState(useProvidersStore.getInitialState(), true);
  onMsgCallback = null;
});

afterEach(() => {
  onMsgCallback = null;
});

// ---- 基础渲染测试 ----

test("渲染表单字段", () => {
  render(<ProviderFormModal onClose={() => {}} />);
  expect(screen.getByText("供应商名称")).toBeTruthy();
  expect(screen.getByText("Base URL")).toBeTruthy();
  expect(screen.getByText("API Key")).toBeTruthy();
  expect(screen.getByText("API 格式")).toBeTruthy();
  expect(screen.getByText(/模型 ID/)).toBeTruthy();
});

test("快捷选择下拉存在", () => {
  render(<ProviderFormModal onClose={() => {}} />);
  const select = screen.getByTestId("preset-select") as HTMLSelectElement;
  expect(select).toBeTruthy();
  expect(select.options[0].textContent).toContain("自定义");
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
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "model-1|" } });
  const saveBtn = screen.getByTestId("provider-save-btn") as HTMLButtonElement;
  expect(saveBtn.disabled).toBe(false);
});

test("tag 添加后模型表格出现行", () => {
  render(<ProviderFormModal onClose={() => {}} />);
  fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByTestId("field-baseUrl"), { target: { value: "https://api.test.com/v1" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "model-1|" } });
  const matches = screen.getAllByText("model-1");
  expect(matches.length).toBeGreaterThanOrEqual(1);
  expect(screen.getByTestId("model-contextWindow-0")).toBeTruthy();
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

test("编辑模式下显示覆盖提示", () => {
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
  expect(screen.getByText("选择预设会覆盖当前表单")).toBeTruthy();
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
  expect(visionCheckbox.checked).toBe(false);
  fireEvent.click(visionCheckbox);
  expect(visionCheckbox.checked).toBe(true);
  fireEvent.click(screen.getByTestId("provider-save-btn"));
  expect(saveMock.mock.calls[0][0].models[0].supportsVision).toBe(true);
});

// ===== 新行为测试 =====

test("收到 model:presets 后下拉出现预设选项", async () => {
  render(<ProviderFormModal onClose={() => {}} />);
  // useEffect 会 send model:presets，mock 立即回复 → 下拉出现选项
  await waitFor(() => {
    const select = screen.getByTestId("preset-select") as HTMLSelectElement;
    expect(select.options.length).toBeGreaterThan(1);
  });
});

test("选择供应商预设后不自动填入模型，只填 name/baseUrl/api", async () => {
  render(<ProviderFormModal onClose={() => {}} />);
  await waitFor(() => {
    const select = screen.getByTestId("preset-select") as HTMLSelectElement;
    expect(select.options.length).toBeGreaterThan(1);
  });
  // 选 DeepSeek
  fireEvent.change(screen.getByTestId("preset-select"), { target: { value: "deepseek" } });
  expect((screen.getByTestId("field-name") as HTMLInputElement).value).toBe("DeepSeek");
  expect((screen.getByTestId("field-baseUrl") as HTMLInputElement).value).toBeTruthy();
  // 模型列表应为空
  expect(screen.queryByTestId("model-contextWindow-0")).toBeNull();
});

test("选择供应商预设后不自动出现下拉，需输入才出现", async () => {
  render(<ProviderFormModal onClose={() => {}} />);
  await waitFor(() => {
    const select = screen.getByTestId("preset-select") as HTMLSelectElement;
    expect(select.options.length).toBeGreaterThan(1);
  });

  // 初始无下拉
  expect(screen.queryByTestId("model-quick-dropdown")).toBeNull();

  // 选 DeepSeek 后仍然无下拉（未输入）
  fireEvent.change(screen.getByTestId("preset-select"), { target: { value: "deepseek" } });
  expect(screen.queryByTestId("model-quick-dropdown")).toBeNull();

  // 输入 "chat" 后出现匹配的模型下拉
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "chat" } });
  const options = screen.getAllByTestId("model-quick-option");
  expect(options.length).toBe(1);
  expect(options[0].textContent).toContain("deepseek-chat");
});

test("输入匹配模型 ID 出现下拉，选择后带入预设参数", async () => {
  const saveMock = mock();
  useProvidersStore.setState({ save: saveMock });
  render(<ProviderFormModal onClose={() => {}} />);
  await waitFor(() => {
    const select = screen.getByTestId("preset-select") as HTMLSelectElement;
    expect(select.options.length).toBeGreaterThan(1);
  });

  fireEvent.change(screen.getByTestId("preset-select"), { target: { value: "deepseek" } });
  // 输入 "chat" 触发下拉
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "chat" } });

  const chatOption = screen.getAllByTestId("model-quick-option")[0];
  fireEvent.mouseDown(chatOption);

  // 模型添加到列表
  expect(screen.getByTestId("model-contextWindow-0")).toBeTruthy();
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.click(screen.getByTestId("provider-save-btn"));
  expect(saveMock.mock.calls[0][0].models[0].contextWindow).toBe(128000);
});

test("输入触发下拉后切换到自定义下拉消失", async () => {
  render(<ProviderFormModal onClose={() => {}} />);
  await waitFor(() => {
    const select = screen.getByTestId("preset-select") as HTMLSelectElement;
    expect(select.options.length).toBeGreaterThan(1);
  });
  fireEvent.change(screen.getByTestId("preset-select"), { target: { value: "deepseek" } });
  // 输入触发下拉
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "chat" } });
  expect(screen.getByTestId("model-quick-dropdown")).toBeTruthy();
  // 切回自定义 → 下拉消失
  fireEvent.change(screen.getByTestId("preset-select"), { target: { value: "" } });
  expect(screen.queryByTestId("model-quick-dropdown")).toBeNull();
});
