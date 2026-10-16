import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactElement } from "react";
import { useProvidersStore } from "../src/store/providers";

// API 调用记录（便于断言）
const apiCalls: { method: string; path: string; body?: any }[] = [];

// 供应商预设数据
const PRESETS = [
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
  {
    key: "opencode-go",
    name: "OpenCode Zen Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    api: "openai-completions",
    models: [
      { id: "deepseek-v4-pro", contextWindow: 1000000, maxTokens: 384000, supportsVision: false },
    ],
  },
];

// mock 需要在 import 之前生效，所以把组件 import 放在 mock.module 之后
mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => {
      apiCalls.push({ method: "get", path });
      if (path === "/api/models/presets") {
        return Promise.resolve({ presets: PRESETS });
      }
      return Promise.resolve({});
    },
    post: (path: string, body?: any) => {
      apiCalls.push({ method: "post", path, body });
      return Promise.resolve({});
    },
    put: (path: string, body?: any) => {
      apiCalls.push({ method: "put", path, body });
      return Promise.resolve({});
    },
    del: (path: string) => {
      apiCalls.push({ method: "del", path });
      return Promise.resolve({});
    },
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
      this.name = "ApiError";
    }
  },
}));

import { ProviderFormModal } from "../src/components/settings/ProviderFormModal";
import { useToastStore } from "../src/store/toast";

beforeEach(() => {
  useProvidersStore.setState(useProvidersStore.getInitialState(), true);
  apiCalls.length = 0;
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  // 个别测试把 providers store 的 save action stub 成 mock，zustand store 是进程级单例，
  // 不还原会泄漏给后面跑的测试文件——恢复初始 state（含原始 action）
  useProvidersStore.setState(useProvidersStore.getInitialState(), true);
});

// 渲染并刷新异步的 preset 加载，避免 act 警告
async function renderWithFlush(element: ReactElement) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(element);
    await Promise.resolve();
  });
  return result!;
}

// ---- 基础渲染测试 ----

test("渲染表单字段", async () => {
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  expect(screen.getByText("供应商名称")).toBeTruthy();
  expect(screen.getByText("Base URL")).toBeTruthy();
  expect(screen.getByText("API Key")).toBeTruthy();
  expect(screen.getByText("API 格式")).toBeTruthy();
  expect(screen.getByText(/模型 ID/)).toBeTruthy();
});

test("点击阴影不关闭弹窗（防止误触丢失表单）", async () => {
  const onClose = mock();
  await renderWithFlush(<ProviderFormModal onClose={onClose} />);
  fireEvent.click(screen.getByTestId("modal-overlay"));
  expect(onClose).not.toHaveBeenCalled();
});

test("快捷选择搜索框存在", async () => {
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  const input = screen.getByTestId("preset-search") as HTMLInputElement;
  expect(input).toBeTruthy();
  expect(input.placeholder).toContain("搜索");
});

test("必填为空时保存按钮禁用", async () => {
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  const saveBtn = screen.getByTestId("provider-save-btn") as HTMLButtonElement;
  expect(saveBtn.disabled).toBe(true);
});

test("填写完整 + 添加模型后保存启用", async () => {
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByTestId("field-baseUrl"), { target: { value: "https://api.test.com/v1" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "model-1|" } });
  const saveBtn = screen.getByTestId("provider-save-btn") as HTMLButtonElement;
  expect(saveBtn.disabled).toBe(false);
});

test("tag 添加后模型表格出现行", async () => {
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByTestId("field-baseUrl"), { target: { value: "https://api.test.com/v1" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "model-1|" } });
  const matches = screen.getAllByText("model-1");
  expect(matches.length).toBeGreaterThanOrEqual(1);
  expect(screen.getByTestId("model-contextWindow-0")).toBeTruthy();
});

test("编辑模式预填 initial 值", async () => {
  await renderWithFlush(
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

test("编辑模式下显示覆盖提示", async () => {
  await renderWithFlush(
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

test("保存调用 store.save", async () => {
  const saveMock = mock();
  useProvidersStore.setState({ save: saveMock });
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
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

test("添加模型后显示 supportsVision 开关并影响保存数据", async () => {
  const saveMock = mock();
  useProvidersStore.setState({ save: saveMock });
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
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

// 辅助：等待预设列表加载并选中指定供应商
async function waitAndSelectPreset(key: string) {
  // 聚焦搜索框触发下拉
  fireEvent.focus(screen.getByTestId("preset-search"));
  await waitFor(() => {
    expect(screen.getAllByTestId("preset-option").length).toBeGreaterThan(1);
  });
  const opt = screen.getAllByTestId("preset-option")
    .find(o => o.getAttribute("data-key") === key)!;
  fireEvent.mouseDown(opt);
}

test("收到 presets 后下拉出现预设选项", async () => {
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  fireEvent.focus(screen.getByTestId("preset-search"));
  await waitFor(() => {
    expect(screen.getAllByTestId("preset-option").length).toBeGreaterThan(1);
  });
});

test("在供应商搜索框输入文字过滤预设", async () => {
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  fireEvent.focus(screen.getByTestId("preset-search"));
  await waitFor(() => {
    expect(screen.getAllByTestId("preset-option").length).toBeGreaterThan(1);
  });
  // 输入 "anth" 过滤
  fireEvent.change(screen.getByTestId("preset-search"), { target: { value: "anth" } });
  const opts = screen.getAllByTestId("preset-option");
  expect(opts.length).toBe(1);
  expect(opts[0].textContent).toContain("Anthropic");
});

test("选择供应商预设后不自动填入模型，只填 name/baseUrl/api", async () => {
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  await waitAndSelectPreset("deepseek");
  expect((screen.getByTestId("field-name") as HTMLInputElement).value).toBe("DeepSeek");
  expect((screen.getByTestId("field-baseUrl") as HTMLInputElement).value).toBeTruthy();
  expect(screen.queryByTestId("model-contextWindow-0")).toBeNull();
});

test("选择供应商预设后不自动出现下拉，需输入才出现", async () => {
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  await waitAndSelectPreset("deepseek");
  // 选后无模型下拉
  expect(screen.queryByTestId("model-quick-dropdown")).toBeNull();
  // 输入 "chat" 后出现
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "chat" } });
  const options = screen.getAllByTestId("model-quick-option");
  expect(options.length).toBe(1);
  expect(options[0].textContent).toContain("deepseek-chat");
});

test("聚焦模型输入框即使无输入也显示全部可用模型下拉", async () => {
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  await waitAndSelectPreset("deepseek");
  // 聚焦输入框（无输入）
  fireEvent.focus(screen.getByTestId("tag-input-field"));
  // 下拉显示全部未添加模型
  await waitFor(() => {
    const opts = screen.getAllByTestId("model-quick-option");
    expect(opts.length).toBeGreaterThanOrEqual(2);
  });
});

test("输入匹配模型 ID 出现下拉，选择后带入预设参数", async () => {
  const saveMock = mock();
  useProvidersStore.setState({ save: saveMock });
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  await waitAndSelectPreset("deepseek");
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "chat" } });
  const chatOption = screen.getAllByTestId("model-quick-option")[0];
  fireEvent.mouseDown(chatOption);
  expect(screen.getByTestId("model-contextWindow-0")).toBeTruthy();
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.click(screen.getByTestId("provider-save-btn"));
  expect(saveMock.mock.calls[0][0].models[0].contextWindow).toBe(128000);
});

test("输入触发下拉后切换到自定义下拉消失", async () => {
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  await waitAndSelectPreset("deepseek");
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "chat" } });
  expect(screen.getByTestId("model-quick-dropdown")).toBeTruthy();
  // 点击预设搜索框，输入任意文字触发清除已选预设
  fireEvent.change(screen.getByTestId("preset-search"), { target: { value: "x" } });
  // 模型下拉消失
  expect(screen.queryByTestId("model-quick-dropdown")).toBeNull();
});

test("选中供应商后 input 右侧显示 × 可清除选择", async () => {
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  await waitAndSelectPreset("deepseek");
  // × 按钮出现
  const clearBtn = screen.getByTestId("preset-clear");
  expect(clearBtn).toBeTruthy();
  // 点击清除
  fireEvent.click(clearBtn);
  // 输入框恢复占位文字
  expect((screen.getByTestId("preset-search") as HTMLInputElement).placeholder).toContain("搜索");
  // 下拉中的供应商可选（不再高亮选中）
  fireEvent.focus(screen.getByTestId("preset-search"));
  await waitFor(() => expect(screen.getAllByTestId("preset-option").length).toBeGreaterThan(1));
});

// ===== 回归：手动输入自定义模型 id 后快捷下拉应消失 =====

test("选中预设后手动输入自定义模型id（回车添加），快捷下拉应消失", async () => {
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  await waitAndSelectPreset("deepseek");
  // 聚焦模型输入框 → 出现全部预设模型下拉
  fireEvent.focus(screen.getByTestId("tag-input-field"));
  await waitFor(() => {
    expect(screen.getAllByTestId("model-quick-option").length).toBeGreaterThanOrEqual(1);
  });
  // 手动输入一个不在预设里的自定义模型 id，回车添加
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "my-custom-model" } });
  fireEvent.keyDown(screen.getByTestId("tag-input-field"), { key: "Enter" });
  // 回车提交后下拉关闭（不再因 modelSearch 清空而卡在"显示全部预设"）
  expect(screen.queryByTestId("model-quick-dropdown")).toBeNull();
});

test("选中预设后用 | 分隔提交自定义模型id，快捷下拉也应消失", async () => {
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  await waitAndSelectPreset("deepseek");
  fireEvent.focus(screen.getByTestId("tag-input-field"));
  await waitFor(() => {
    expect(screen.getAllByTestId("model-quick-option").length).toBeGreaterThanOrEqual(1);
  });
  // 用分隔符提交自定义模型 id
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "my-custom|" } });
  expect(screen.queryByTestId("model-quick-dropdown")).toBeNull();
});

// ===== 预设 slug 落库：修复 Model not found 根因 =====

test("选预设后保存：provider.slug === preset.key（对齐内置 provider id）", async () => {
  const saveMock = mock();
  useProvidersStore.setState({ save: saveMock });
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  await waitAndSelectPreset("opencode-go");
  // 选预设只填 name/baseUrl/api，需手动补 apiKey + 模型
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-xxx" } });
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "deepseek-v4-pro" } });
  const chatOption = screen.getAllByTestId("model-quick-option")[0];
  fireEvent.mouseDown(chatOption);
  fireEvent.click(screen.getByTestId("provider-save-btn"));
  const saved = saveMock.mock.calls[0][0];
  expect(saved.slug).toBe("opencode-go");
});

test("不选预设手动填表保存：provider.slug 为 undefined（自定义 provider）", async () => {
  const saveMock = mock();
  useProvidersStore.setState({ save: saveMock });
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  fireEvent.change(screen.getByTestId("field-name"), { target: { value: "My Custom" } });
  fireEvent.change(screen.getByTestId("field-baseUrl"), { target: { value: "https://api.test.com/v1" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "m1|" } });
  fireEvent.click(screen.getByTestId("provider-save-btn"));
  const saved = saveMock.mock.calls[0][0];
  expect(saved.slug).toBeUndefined();
});

test("清除预设后保存：slug 应回到 undefined（避免残留旧 slug）", async () => {
  const saveMock = mock();
  useProvidersStore.setState({ save: saveMock });
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  await waitAndSelectPreset("deepseek");
  // 清除预设
  fireEvent.click(screen.getByTestId("preset-clear"));
  // 手动填自定义内容后保存
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.change(screen.getByTestId("tag-input-field"), { target: { value: "m1|" } });
  fireEvent.click(screen.getByTestId("provider-save-btn"));
  const saved = saveMock.mock.calls[0][0];
  expect(saved.slug).toBeUndefined();
});

test("编辑已有 provider（带 slug）时保留原 slug", async () => {
  const saveMock = mock();
  useProvidersStore.setState({ save: saveMock });
  await renderWithFlush(
    <ProviderFormModal
      initial={{
        id: "p1", name: "OpenCode Zen Go", slug: "opencode-go",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "sk-existing", api: "openai-completions",
        models: [{ id: "deepseek-v4-pro", contextWindow: 1000000, maxTokens: 384000 }],
      }}
      onClose={() => {}}
    />
  );
  // 不改预设，直接保存（模型已存在，表单可保存）
  fireEvent.click(screen.getByTestId("provider-save-btn"));
  const saved = saveMock.mock.calls[0][0];
  expect(saved.slug).toBe("opencode-go");
});

// ===== 测试连接失败 → toast（不再 inline）=====

test("测试连接失败 → 用 toast 提示，不再 inline 显示失败文案", async () => {
  // stub store.test 返回失败
  useProvidersStore.setState({
    test: async () => ({ ok: false, error: "API Key 无效" }),
  });
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByTestId("field-baseUrl"), { target: { value: "https://api.test.com/v1" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.click(screen.getByText("测试连接"));
  await waitFor(() => {
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].type).toBe("error");
    expect(useToastStore.getState().toasts[0].message).toBe("API Key 无效");
  });
  // 不再 inline 显示失败文案
  expect(screen.queryByText(/失败/)).toBeNull();
});

test("测试连接成功 → 仍 inline 显示「✓ 连接成功」，不弹 toast", async () => {
  useProvidersStore.setState({
    test: async () => ({ ok: true }),
  });
  await renderWithFlush(<ProviderFormModal onClose={() => {}} />);
  fireEvent.change(screen.getByTestId("field-name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByTestId("field-baseUrl"), { target: { value: "https://api.test.com/v1" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.click(screen.getByText("测试连接"));
  await waitFor(() => expect(screen.getByText(/连接成功/)).toBeTruthy());
  // 成功不弹 toast
  expect(useToastStore.getState().toasts).toHaveLength(0);
});
