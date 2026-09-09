import { describe, test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModelSelector } from "../src/components/ui/ModelSelector";
import { ThinkingSelector } from "../src/components/ui/ThinkingSelector";
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
      providers: [
        {
          id: "p1",
          name: "Test",
          baseUrl: "http://x",
          apiKey: "k",
          api: "openai-completions",
          models: [
            { id: "m1", contextWindow: 128000, maxTokens: 4096 },
            { id: "m2", contextWindow: 128000, maxTokens: 4096 },
          ],
        },
      ],
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
        {
          id: "p1",
          name: "A",
          baseUrl: "http://x",
          apiKey: "k",
          api: "openai-completions",
          models: [{ id: "m1", contextWindow: 128000, maxTokens: 4096 }],
        },
        {
          id: "p2",
          name: "B",
          baseUrl: "http://y",
          apiKey: "k",
          api: "openai-completions",
          models: [{ id: "m1", contextWindow: 128000, maxTokens: 4096 }],
        },
      ],
    });
    const onChange = mock();
    render(<ModelSelector value="old-slug/m1" onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("auto-select 触发后 value 被清空仍能再次触发", async () => {
    const onChange = mock();
    const { rerender } = render(
      <ModelSelector value={null} onChange={onChange} />,
    );
    // 初始 auto-select
    expect(onChange).toHaveBeenCalledWith("test/m1");

    // onChange 更新了父组件状态，value 变为 auto-selected 值
    rerender(<ModelSelector value="test/m1" onChange={onChange} />);

    // 切换会话：value 变回 null
    rerender(<ModelSelector value={null} onChange={onChange} />);
    // 应再次触发 auto-select（但当前 autoSelectedRef 已是 true，会失败）
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test("autoSelectEnabled=false（会话 prefs 未加载完）时禁止 auto-select，启用后补触发", () => {
    const onChange = mock();
    const { rerender } = render(
      <ModelSelector
        value={null}
        onChange={onChange}
        autoSelectEnabled={false}
      />,
    );
    // prefs 冷加载间隙：不得 auto-select（否则会覆盖会话存储的 model）
    expect(onChange).not.toHaveBeenCalled();

    // prefs 加载完成且确无 model（全新会话）：恢复 auto-select 职责
    rerender(
      <ModelSelector
        value={null}
        onChange={onChange}
        autoSelectEnabled={true}
      />,
    );
    expect(onChange).toHaveBeenCalledWith("test/m1");
  });

  // ===== 预设 provider：带 slug 字段时用 slug 而非 name 派生（修复 Model not found）=====

  test("provider 带 slug 字段时选项 value 用 slug 而非 name 派生", () => {
    useProvidersStore.setState({
      providers: [
        {
          id: "p1",
          name: "OpenCode Zen Go",
          slug: "opencode-go",
          baseUrl: "https://opencode.ai/zen/go/v1",
          apiKey: "k",
          api: "openai-completions",
          models: [
            {
              id: "deepseek-v4-pro",
              contextWindow: 1000000,
              maxTokens: 384000,
            },
          ],
        },
      ],
    });
    render(
      <ModelSelector value="opencode-go/deepseek-v4-pro" onChange={() => {}} />,
    );
    const select = screen.getByTestId("model-selector") as HTMLSelectElement;
    // 选项 value 应是 slug/id（opencode-go），而不是从 name 派生的 opencode-zen-go
    const opt = select.querySelector(
      'option[value="opencode-go/deepseek-v4-pro"]',
    ) as HTMLOptionElement;
    expect(opt).toBeTruthy();
    // 不应出现从 name 派生的错误 slug
    const wrongOpt = select.querySelector(
      'option[value="opencode-zen-go/deepseek-v4-pro"]',
    );
    expect(wrongOpt).toBeNull();
  });

  test("provider 无 slug 时仍用 name 派生（向后兼容）", () => {
    render(<ModelSelector value="test/m1" onChange={() => {}} />);
    const select = screen.getByTestId("model-selector") as HTMLSelectElement;
    const opt = select.querySelector(
      'option[value="test/m1"]',
    ) as HTMLOptionElement;
    expect(opt).toBeTruthy();
  });
});

// ===== 宽度收缩：选择器按「当前选中项」而非「最宽 option」撑宽 =====
// 原生 select 的固有宽度取最宽 option，模型名长短差异大时选择器被撑得过宽、
// 下拉箭头离文字太远。修法是「不可见占位 span 撑出当前项宽度 + select 铺满」，
// happy-dom 不计算布局，故断言驱动宽度的结构（占位 span 的文案 = 当前选中项）。
describe("ModelSelector 宽度收缩", () => {
  const shortLabel = "很短/qwen-turbo";
  const longLabel =
    "阿里云 Token Plan CN/qwen3.8-flash-plus-very-long-model-name";

  beforeEach(() => {
    useProvidersStore.setState({
      providers: [
        {
          id: "p1",
          name: "很短",
          slug: "short",
          baseUrl: "http://x",
          apiKey: "k",
          api: "openai-completions",
          models: [
            { id: "qwen-turbo", contextWindow: 128000, maxTokens: 4096 },
          ],
        },
        {
          id: "p2",
          name: "阿里云 Token Plan CN",
          slug: "aliyun",
          baseUrl: "http://y",
          apiKey: "k",
          api: "openai-completions",
          models: [
            {
              id: "qwen3.8-flash-plus-very-long-model-name",
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      ],
    } as any);
  });

  const sizer = () =>
    document.querySelector("[data-testid='model-selector-sizer']");

  test("占位 span 的文案是当前选中项，不是最宽 option", () => {
    render(
      <ModelSelector
        value="short/qwen-turbo"
        onChange={() => {}}
        autoSelectEnabled={false}
      />,
    );
    expect(sizer()?.textContent).toBe(shortLabel);
    // 最长的那条模型名仍在选项里（原生宽度正是被它撑开的）
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toContain(
      longLabel,
    );
  });

  test("受控 value 更新后占位 span 跟随换成新选中项", () => {
    const { rerender } = render(
      <ModelSelector
        value="short/qwen-turbo"
        onChange={() => {}}
        autoSelectEnabled={false}
      />,
    );
    rerender(
      <ModelSelector
        value="aliyun/qwen3.8-flash-plus-very-long-model-name"
        onChange={() => {}}
        autoSelectEnabled={false}
      />,
    );
    expect(sizer()?.textContent).toBe(longLabel);
  });

  test("未选模型时占位为提示文案，避免宽度塌成 0", () => {
    render(
      <ModelSelector
        value={null}
        onChange={() => {}}
        autoSelectEnabled={false}
      />,
    );
    expect(sizer()?.textContent).toBe("选择模型");
  });

  // providers 异步加载完成会让 models 从 0 变 >0，若撑宽用的 useMemo 写在
  // 「无模型」early return 之后，hook 数量变化会直接让组件崩溃。
  test("providers 从空到加载完成（models 0 → n）不触发 hooks 顺序报错", () => {
    useProvidersStore.setState({ providers: [] } as any);
    const { rerender } = render(
      <ModelSelector
        value={null}
        onChange={() => {}}
        autoSelectEnabled={false}
      />,
    );
    expect(screen.getByText("未配置模型")).toBeTruthy();
    useProvidersStore.setState({
      providers: [
        {
          id: "p1",
          name: "很短",
          slug: "short",
          baseUrl: "http://x",
          apiKey: "k",
          api: "openai-completions",
          models: [
            { id: "qwen-turbo", contextWindow: 128000, maxTokens: 4096 },
          ],
        },
      ],
    } as any);
    rerender(
      <ModelSelector
        value="short/qwen-turbo"
        onChange={() => {}}
        autoSelectEnabled={false}
      />,
    );
    expect(screen.getByTestId("model-selector")).toBeTruthy();
    expect(sizer()?.textContent).toBe(shortLabel);
  });

  test("箭头图标随选择器一起渲染（appearance-none 后需自带箭头）", () => {
    render(
      <ModelSelector
        value="short/qwen-turbo"
        onChange={() => {}}
        autoSelectEnabled={false}
      />,
    );
    const select = screen.getByTestId("model-selector");
    // 箭头与 select、占位 span 同层（由同一个网格容器约束），三者缺一不可
    const host = select.parentElement!;
    expect(host.querySelector("svg")).toBeTruthy();
    expect(
      host.querySelector("[data-testid='model-selector-sizer']"),
    ).toBeTruthy();
    // select 必须 appearance-none，否则会与自画箭头重叠
    expect(select.className).toContain("appearance-none");
    // select 不参与列宽固有计算（w-0 + min-w-full），宽度全由占位 span 决定
    expect(select.className).toContain("w-0");
    expect(select.className).toContain("min-w-full");
  });

  // 用户反馈：模型选择器与思考强度选择器的下拉箭头长得不一样
  // （一边自绘 chevron、一边是各平台原生箭头）。两者均改走 AutoWidthSelect 后必须完全一致。
  test("模型选择器与思考强度选择器的箭头为同一枚自绘 chevron", () => {
    const chevronOf = (testId: string) => {
      const select = screen.getByTestId(testId);
      const svg = select.parentElement!.querySelector("svg")!;
      return {
        outer: svg.outerHTML.replace(/data-testid="[^"]*"/g, ""),
        path: svg.querySelector("path")!.getAttribute("d"),
      };
    };
    render(
      <>
        <ModelSelector
          value="short/qwen-turbo"
          onChange={() => {}}
          autoSelectEnabled={false}
        />
        <ThinkingSelector value="max" onChange={() => {}} />
      </>,
    );
    const model = chevronOf("model-selector");
    const thinking = chevronOf("thinking-selector");
    // 同一图形（chevron-down 的 path）
    expect(model.path).toBe(thinking.path);
    // 同一尺寸与颜色类（箭头随文字大小缩放，不会一个 12px 一个原生箭头）
    expect(model.outer).toBe(thinking.outer);
    expect(model.path).toContain("9.5l6 6 6-6");
  });
});
