import { describe, it, expect, vi, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AskFormCard } from "../src/components/ask/AskFormCard";
import type { AskParams } from "@hiagent/shared";
import * as ws from "../src/ws-instance";

const params: AskParams = {
  questions: [
    {
      question: "数据存储方案?",
      header: "存储",
      options: [
        { label: "SQLite", description: "轻量" },
        { label: "PostgreSQL", description: "生产级" },
      ],
    },
  ],
};

// 截获 WS 发送：vi.spyOn 捕获 send 调用，把事件 push 到 sent
const sent: any[] = [];

describe("AskFormCard", () => {
  beforeEach(() => {
    sent.length = 0;
    vi.spyOn(ws, "send").mockImplementation((e: any) => {
      sent.push(e);
    });
  });

  it("渲染问题与选项；点选 + 提交 → 发 agent:answer", () => {
    render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
    // 问题文本前缀了 "Q · "，用 substring 匹配
    expect(screen.getByText("数据存储方案?", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByText("PostgreSQL"));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("agent:answer");
    expect(sent[0].sessionId).toBe("s1");
    expect(sent[0].toolCallId).toBe("tc1");
    expect(sent[0].reply.replies[0].selected).toEqual(["PostgreSQL"]);
  });

  it("未选择时提交禁用", () => {
    render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
    const submit = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("取消 → 发 agent:cancel-ask", () => {
    render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
    // footer 的「取消」文字按钮
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("agent:cancel-ask");
  });

  it("右上角 ✕（终止）→ 发 agent:cancel-ask", () => {
    render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
    fireEvent.click(screen.getByRole("button", { name: "终止提问" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("agent:cancel-ask");
  });

  it("Other：展开文本框，填入后可提交（kind=custom）", () => {
    render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
    fireEvent.click(screen.getByText("其他…"));
    const input = screen.getByPlaceholderText("输入自定义答案…") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Redis" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(sent[0].reply.replies[0].customText).toBe("Redis");
    expect(sent[0].reply.replies[0].selected).toEqual([]);
  });

  it("多选：可勾多个；切换 multiSelect 互不干扰", () => {
    const mp: AskParams = {
      questions: [
        {
          question: "多选?",
          header: "h",
          multiSelect: true,
          options: [
            { label: "A", description: "x" },
            { label: "B", description: "y" },
            { label: "C", description: "z" },
          ],
        },
      ],
    };
    render(<AskFormCard sessionId="s1" toolCallId="tc1" params={mp} />);
    fireEvent.click(screen.getByText("A"));
    fireEvent.click(screen.getByText("C"));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(sent[0].reply.replies[0].selected.sort()).toEqual(["A", "C"]);
  });

  it("选「其他」取消普通选项选择；未输入文字时提交禁用；输入后可提交", () => {
    render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
    // 先选一个普通选项
    fireEvent.click(screen.getByText("PostgreSQL"));
    // 再选「其他」→ 普通选项被清空，进入 other 模式
    fireEvent.click(screen.getByText("其他…"));
    const submit = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
    // 未输入文字 → 提交禁用
    expect(submit.disabled).toBe(true);
    // 输入文字 → 可提交，selected 为空、customText 为输入值
    const input = screen.getByPlaceholderText("输入自定义答案…") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Redis" } });
    expect((screen.getByRole("button", { name: "提交" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(sent[0].reply.replies[0].selected).toEqual([]);
    expect(sent[0].reply.replies[0].customText).toBe("Redis");
  });
});
