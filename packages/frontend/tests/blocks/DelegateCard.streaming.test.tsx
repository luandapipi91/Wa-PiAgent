import { test, expect, beforeEach } from "bun:test";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { DelegateCard } from "../../src/components/blocks/DelegateCard";
import { useSessionStore } from "../../src/store/session";
import { useUiPrefsStore } from "../../src/store/ui-prefs";

beforeEach(() => {
  useSessionStore.setState({
    progressByToolCall: {},
    progressSessionByToolCall: {},
  });
  // 本文件基线为「回复过程折叠开关关闭」（执行中默认展开），聚焦卡片内容渲染；
  // 折叠开关行为由 process-collapse.behavior 测试单独覆盖。
  useUiPrefsStore.setState({ collapseProcessByDefault: false });
});

test("执行中 progress.output 渲染纯文本预览，不跑 markdown", () => {
  render(
    <DelegateCard
      sessionId="s1"
      toolCall={{
        type: "toolCall",
        id: "c1",
        name: "delegate",
        arguments: { agent: "pm", task: "调研" },
      }}
    />,
  );
  act(() => {
    useSessionStore.getState().handleSubagentProgress("s1", "c1", {
      agent: "pm",
      status: "running",
      output: "**加粗** 内容",
      tools: [],
      elapsedMs: 100,
    });
  });
  const plain = screen.getByTestId("streaming-output-plain");
  expect(plain.textContent).toBe("**加粗** 内容");
  expect(plain.querySelector("strong")).toBeNull();
});

test("完成后（result 到达）渲染完整 markdown", () => {
  render(
    <DelegateCard
      sessionId="s1"
      toolCall={{
        type: "toolCall",
        id: "c2",
        name: "delegate",
        arguments: { agent: "pm", task: "调研" },
      }}
      result={
        {
          role: "toolResult",
          toolCallId: "c2",
          content: [{ type: "text", text: "**加粗** 结果" }],
          isError: false,
          timestamp: 1,
        } as any
      }
    />,
  );
  // 完成态卡片默认折叠（ProcessCard open=false 不渲染 children）；
  // 点击头部展开后 children 渲染，验证完成态 result 走完整 markdown 分支（而非纯文本）。
  act(() => {
    fireEvent.click(screen.getByTestId("delegate-c2-header"));
  });
  const md = screen.getByTestId("streaming-output-md");
  expect(md.querySelector("strong")?.textContent).toBe("加粗");
});
