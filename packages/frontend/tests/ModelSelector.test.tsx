import { describe, test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModelSelector } from "../src/components/ui/ModelSelector";
import { useProvidersStore } from "../src/store/providers";

mock.module("../src/api-client", () => ({
  api: {
    get: () => Promise.resolve({}),
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
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

describe("ModelSelector", () => {
  beforeEach(() => {
    useProvidersStore.setState({
      providers: [{
        id: "p1", name: "Test", baseUrl: "http://x", apiKey: "k", api: "openai-completions",
        models: [
          { id: "m1", contextWindow: 128000, maxTokens: 4096 },
          { id: "m2", contextWindow: 128000, maxTokens: 4096 },
        ],
      }],
    });
  });

  test("renders model options from providers", () => {
    const onChange = mock();
    render(<ModelSelector value="m1" onChange={onChange} />);
    expect(screen.getByTestId("model-selector")).toBeTruthy();
    expect(screen.getByText("Test/m1")).toBeTruthy();
    expect(screen.getByText("Test/m2")).toBeTruthy();
  });

  test("changing value triggers onChange", () => {
    const onChange = mock();
    render(<ModelSelector value="test/m1" onChange={onChange} />);
    const select = screen.getByTestId("model-selector") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "test/m2" } });
    expect(onChange).toHaveBeenCalledWith("test/m2");
  });

  test("disables the select when disabled is true", () => {
    render(<ModelSelector value="m1" onChange={() => {}} disabled />);
    const select = screen.getByTestId("model-selector") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  test("renders empty hint when no models are configured", () => {
    useProvidersStore.setState({ providers: [] });
    render(<ModelSelector value={null} onChange={() => {}} />);
    expect(screen.getByText("未配置模型")).toBeTruthy();
  });

  test("heals stale slug/id (provider renamed) to the current slug", () => {
    const onChange = mock();
    render(<ModelSelector value="old-slug/m1" onChange={onChange} />);
    expect(onChange).toHaveBeenCalledWith("test/m1");
  });

  test("does not heal when the model id exists under multiple providers", () => {
    useProvidersStore.setState({
      providers: [
        { id: "p1", name: "A", baseUrl: "http://x", apiKey: "k", api: "openai-completions", models: [{ id: "m1", contextWindow: 128000, maxTokens: 4096 }] },
        { id: "p2", name: "B", baseUrl: "http://y", apiKey: "k", api: "openai-completions", models: [{ id: "m1", contextWindow: 128000, maxTokens: 4096 }] },
      ],
    });
    const onChange = mock();
    render(<ModelSelector value="old-slug/m1" onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("auto-select 触发后 value 被清空仍能再次触发", async () => {
    const onChange = mock();
    const { rerender } = render(<ModelSelector value={null} onChange={onChange} />);
    // 初始 auto-select
    expect(onChange).toHaveBeenCalledWith("test/m1");

    // onChange 更新了父组件状态，value 变为 auto-selected 值
    rerender(<ModelSelector value="test/m1" onChange={onChange} />);

    // 切换会话：value 变回 null
    rerender(<ModelSelector value={null} onChange={onChange} />);
    // 应再次触发 auto-select（但当前 autoSelectedRef 已是 true，会失败）
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  // ===== 预设 provider：带 slug 字段时用 slug 而非 name 派生（修复 Model not found）=====

  test("provider 带 slug 字段时选项 value 用 slug 而非 name 派生", () => {
    useProvidersStore.setState({
      providers: [{
        id: "p1", name: "OpenCode Zen Go", slug: "opencode-go",
        baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "k", api: "openai-completions",
        models: [{ id: "deepseek-v4-pro", contextWindow: 1000000, maxTokens: 384000 }],
      }],
    });
    render(<ModelSelector value="opencode-go/deepseek-v4-pro" onChange={() => {}} />);
    const select = screen.getByTestId("model-selector") as HTMLSelectElement;
    // 选项 value 应是 slug/id（opencode-go），而不是从 name 派生的 opencode-zen-go
    const opt = select.querySelector('option[value="opencode-go/deepseek-v4-pro"]') as HTMLOptionElement;
    expect(opt).toBeTruthy();
    // 不应出现从 name 派生的错误 slug
    const wrongOpt = select.querySelector('option[value="opencode-zen-go/deepseek-v4-pro"]');
    expect(wrongOpt).toBeNull();
  });

  test("provider 无 slug 时仍用 name 派生（向后兼容）", () => {
    render(<ModelSelector value="test/m1" onChange={() => {}} />);
    const select = screen.getByTestId("model-selector") as HTMLSelectElement;
    const opt = select.querySelector('option[value="test/m1"]') as HTMLOptionElement;
    expect(opt).toBeTruthy();
  });
});
