// AutoWidthSelect：下拉选择器的自适应宽度外壳 + 统一自绘箭头。
// 关键契约（都是历史踩过的坑）：
//  1. 宽度按「当前选中项」而非「最宽 option」计算（占位 span 撑宽）；
//  2. 箭头为自绘 Icon，所有下拉共用同一实现，避免一边原生、一边自绘。
import { describe, test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AutoWidthSelect } from "./AutoWidthSelect";

const OPTIONS = [
  { value: "", label: "请选择", disabled: true },
  { value: "a", label: "短" },
  { value: "b", label: "很长很长很长的一选项" },
];

describe("AutoWidthSelect", () => {
  test("渲染当前选中项文案与全部选项，未选时占位为提示文案", () => {
    render(
      <AutoWidthSelect
        testId="x"
        ariaLabel="x"
        value="a"
        onChange={() => {}}
        options={OPTIONS}
      />,
    );
    expect((screen.getByTestId("x") as HTMLSelectElement).options.length).toBe(
      3,
    );
    expect(screen.getByTestId("x-sizer")!.textContent).toBe("短");
    // 未选（value=""）→ 命中禁用的占位项
    render(
      <AutoWidthSelect
        testId="y"
        ariaLabel="y"
        value=""
        onChange={() => {}}
        options={OPTIONS}
      />,
    );
    expect(screen.getByTestId("y-sizer")!.textContent).toBe("请选择");
  });

  test("选中项变化时占位 span 跟随（宽度由它决定）", () => {
    const { rerender } = render(
      <AutoWidthSelect
        testId="z"
        ariaLabel="z"
        value="a"
        onChange={() => {}}
        options={OPTIONS}
      />,
    );
    expect(screen.getByTestId("z-sizer")!.textContent).toBe("短");
    rerender(
      <AutoWidthSelect
        testId="z"
        ariaLabel="z"
        value="b"
        onChange={() => {}}
        options={OPTIONS}
      />,
    );
    expect(screen.getByTestId("z-sizer")!.textContent).toBe(
      "很长很长很长的一选项",
    );
  });

  test("select 必须 appearance-none + w-0/min-w-full，并自带箭头 svg", () => {
    render(
      <AutoWidthSelect
        testId="s"
        ariaLabel="s"
        value="a"
        onChange={() => {}}
        options={OPTIONS}
      />,
    );
    const select = screen.getByTestId("s");
    const host = select.parentElement!;
    for (const cls of ["appearance-none", "w-0", "min-w-full", "truncate"]) {
      expect(select.className).toContain(cls);
    }
    const svg = host.querySelector("svg")!;
    expect(svg).toBeTruthy();
    // 箭头盒子 1.5em：chevron-down 图形只占 viewBox 宽度的一半，1em 盒子画出来只有 ~6px、
    // 比原生箭头小一圈；靠 text-xs 解析 em，使箭头随设置里的「文字大小」缩放。
    expect(svg.getAttribute("width")).toBe("1.5em");
    const svgCls = svg.getAttribute("class") ?? "";
    expect(svgCls).toContain("text-xs");
    expect(svgCls).toContain("pointer-events-none");
    // 内边距必须大于箭头盒子宽度，否则长文本会压到箭头上
    expect(select.className).toContain("pr-5");
    expect(host.querySelector("[data-testid='s-sizer']")!.className).toContain(
      "pr-5",
    );
  });

  test("onChange 回传选中值，disabled 透传", () => {
    const changes: string[] = [];
    render(
      <AutoWidthSelect
        testId="c"
        ariaLabel="c"
        value="a"
        onChange={(v) => changes.push(v)}
        options={OPTIONS}
        disabled
      />,
    );
    const select = screen.getByTestId("c") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    fireEvent.change(select, { target: { value: "b" } });
    expect(changes).toEqual(["b"]);
  });
});
