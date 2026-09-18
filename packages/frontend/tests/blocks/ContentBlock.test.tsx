import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThinkingPanel } from "../../src/components/blocks/ThinkingPanel";
import { Markdown } from "../../src/components/blocks/Markdown";
import { ToolCallPanel } from "../../src/components/blocks/ToolCallPanel";
import { DelegateCard } from "../../src/components/blocks/DelegateCard";
import { useUiPrefsStore } from "../../src/store/ui-prefs";

// 本文件测试卡片内容渲染逻辑，基线为「回复过程折叠开关关闭」（执行中默认展开）；
// 折叠开关行为由 process-collapse.behavior 测试单独覆盖。
beforeEach(() => {
  useUiPrefsStore.setState({ collapseProcessByDefault: false });
});

test("ThinkingPanel 默认折叠，点击展开", () => {
  render(<ThinkingPanel thinking="我在想" />);
  expect(screen.queryByText("我在想")).toBeNull();
  fireEvent.click(screen.getByText(/思考过程/));
  expect(screen.getByText("我在想")).toBeTruthy();
});

test("Markdown 渲染代码块（原 TextBlock 死代码已并入统一组件）", () => {
  render(<Markdown text={"```js\nconst x = 1;\n```"} sessionId="s1" />);
  // 默认挂交互组件：代码块走 CodeBlockCard（纯文本形态由 interactive=false 覆盖）
  expect(screen.getByTestId("code-block-card")).toBeTruthy();
});

test("ToolCallPanel 显示工具名和参数", () => {
  render(
    <ToolCallPanel
      toolCall={{
        type: "toolCall",
        id: "c1",
        name: "read",
        arguments: { path: "/a" },
      }}
    />,
  );
  expect(screen.getByText(/read/)).toBeTruthy();
});

test("DelegateCard 渲染委派卡片（ProcessCard）：头部含委派对象，执行中默认展开，任务直接可见", () => {
  render(
    <DelegateCard
      sessionId="s1"
      toolCall={{
        type: "toolCall",
        id: "c1",
        name: "delegate",
        arguments: { agent: "pm", task: "需求?" },
      }}
    />,
  );
  expect(screen.getByTestId("delegate-c1-header").textContent).toContain(
    "委派给 pm",
  );
  // executingMode 下未完成（无 result）默认展开，任务直接可见无需点击
  expect(screen.getByText(/需求\?/)).toBeTruthy();
});
