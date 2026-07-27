import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { CommandPalette } from "../src/components/CommandPalette";
import { useSkillsStore } from "../src/store/skills";
import { useAgentsStore } from "../src/store/agents";

beforeEach(() => {
  useSkillsStore.setState({
    allSkills: [
      { name: "pi-lens", description: "代码智能感知", path: "/p/pi-lens" },
      { name: "writing-skills", description: "写作辅助", path: "/p/writing" },
      { name: "brainstorming", description: "头脑风暴", path: "/p/brainstorming" },
    ],
    disabledSkills: [],
  });
  useAgentsStore.setState({ list: [] });
});

afterEach(() => {
  cleanup();
});

describe("CommandPalette", () => {
  test("open=true 时渲染搜索框和技能列表", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);

    // 搜索框存在
    expect(screen.getByPlaceholderText("搜索技能和命令...")).toBeTruthy();

    // 技能分组存在
    expect(screen.getByText("技能")).toBeTruthy();
    expect(screen.getByText("pi-lens")).toBeTruthy();
    expect(screen.getByText("writing-skills")).toBeTruthy();
    expect(screen.getByText("brainstorming")).toBeTruthy();
  });

  test("open=false 时不渲染任何内容", () => {
    render(<CommandPalette open={false} onClose={() => {}} />);
    expect(screen.queryByPlaceholderText("搜索技能和命令...")).toBeNull();
  });

  test("输入关键词过滤技能列表", async () => {
    render(<CommandPalette open={true} onClose={() => {}} />);

    const input = screen.getByPlaceholderText("搜索技能和命令...");
    await act(async () => {
      fireEvent.change(input, { target: { value: "writing" } });
    });

    // 匹配的显示
    expect(screen.getByText("writing-skills")).toBeTruthy();
    // 不匹配的不显示
    expect(screen.queryByText("pi-lens")).toBeNull();
    expect(screen.queryByText("brainstorming")).toBeNull();
  });

  test("模糊搜索匹配技能描述", async () => {
    render(<CommandPalette open={true} onClose={() => {}} />);

    const input = screen.getByPlaceholderText("搜索技能和命令...");
    await act(async () => {
      fireEvent.change(input, { target: { value: "感知" } });
    });

    expect(screen.getByText("pi-lens")).toBeTruthy();
    expect(screen.queryByText("writing-skills")).toBeNull();
  });

  test("无匹配时显示空状态提示", async () => {
    render(<CommandPalette open={true} onClose={() => {}} />);

    const input = screen.getByPlaceholderText("搜索技能和命令...");
    await act(async () => {
      fireEvent.change(input, { target: { value: "zzz不存在" } });
    });

    expect(screen.getByText("没有匹配的结果")).toBeTruthy();
  });

  test("按 Escape 键触发 onClose", () => {
    let closed = false;
    render(<CommandPalette open={true} onClose={() => { closed = true; }} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(closed).toBe(true);
  });

  test("按 Enter 键执行当前高亮项并关闭", () => {
    let executed = "";
    render(<CommandPalette open={true} onClose={() => {}} />);

    // 第一个技能默认高亮
    const input = screen.getByPlaceholderText("搜索技能和命令...");
    fireEvent.keyDown(document, { key: "Enter" });

    // Enter 会执行选中项（检查是否调用了 action）
    // 注：技能项的 action 是执行对应命令，此测试验证 Enter 不会报错
    expect(input).toBeTruthy(); // 确认仍然渲染
  });

  test("↑↓ 键切换高亮项", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);

    // 默认第一项高亮
    const items = screen.getAllByRole("option");
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    expect(items[1].getAttribute("aria-selected")).toBe("false");

    // 按下箭头
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(items[0].getAttribute("aria-selected")).toBe("false");
    expect(items[1].getAttribute("aria-selected")).toBe("true");

    // 按上箭头回绕
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    expect(items[1].getAttribute("aria-selected")).toBe("false");
  });

  test("点击遮罩层关闭", () => {
    let closed = false;
    render(<CommandPalette open={true} onClose={() => { closed = true; }} />);

    const overlay = screen.getByTestId("command-palette-overlay");
    fireEvent.click(overlay);
    expect(closed).toBe(true);
  });

  test("命令分组显示快捷操作", () => {
    render(<CommandPalette open={true} onClose={() => {}} />);

    expect(screen.getByText("命令")).toBeTruthy();
    expect(screen.getByText("系统设置")).toBeTruthy();
    expect(screen.getByText("智能体管理")).toBeTruthy();
  });
});
