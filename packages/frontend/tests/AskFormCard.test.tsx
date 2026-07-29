import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import type { AskParams } from "@wa-pi/shared";

const sent: any[] = [];

mock.module("../src/api-client", () => ({
  api: {
    get: () => Promise.resolve({}),
    post: (_path: string, body?: any) => { sent.push({ path: _path, body }); return Promise.resolve({}); },
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
  ApiError: class extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; this.name = "ApiError"; } },
}));

import { AskFormCard } from "../src/components/ask/AskFormCard";

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

describe("AskFormCard", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("渲染问题与选项；点选 + 提交 → 发 answer", () => {
    render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
    expect(screen.getByText("数据存储方案?", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByText("PostgreSQL"));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toContain("/api/sessions/s1/answer");
    expect(sent[0].body.toolCallId).toBe("tc1");
    expect(sent[0].body.reply.replies[0].selected).toEqual(["PostgreSQL"]);
  });

  it("未选择时提交禁用", () => {
    render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
    const submit = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("取消 → 发 cancel-ask", () => {
    render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toContain("/api/sessions/s1/cancel-ask");
  });

  it("右上角 ✕（终止）→ 发 cancel-ask", () => {
    render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
    fireEvent.click(screen.getByRole("button", { name: "终止提问" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toContain("/api/sessions/s1/cancel-ask");
  });

  it("Other：展开文本框，填入后可提交（kind=custom）", () => {
    render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
    fireEvent.click(screen.getByText("其他…"));
    const input = screen.getByPlaceholderText("输入自定义答案…") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Redis" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(sent[0].body.reply.replies[0].customText).toBe("Redis");
    expect(sent[0].body.reply.replies[0].selected).toEqual([]);
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
    expect(sent[0].body.reply.replies[0].selected.sort()).toEqual(["A", "C"]);
  });

  it("选「其他」取消普通选项选择；未输入文字时提交禁用；输入后可提交", () => {
    render(<AskFormCard sessionId="s1" toolCallId="tc1" params={params} />);
    fireEvent.click(screen.getByText("PostgreSQL"));
    fireEvent.click(screen.getByText("其他…"));
    const submit = screen.getByRole("button", { name: "提交" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const input = screen.getByPlaceholderText("输入自定义答案…") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Redis" } });
    expect((screen.getByRole("button", { name: "提交" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(sent[0].body.reply.replies[0].selected).toEqual([]);
    expect(sent[0].body.reply.replies[0].customText).toBe("Redis");
  });
});
