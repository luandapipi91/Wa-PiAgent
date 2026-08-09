// ExtensionDialog.test.tsx — pi 扩展 dialog 弹窗（select/confirm/input/editor）组件测试
// mock api-client（仿 Composer.test.tsx 模式），断言各 method 的渲染与应答 POST 载荷。
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const sent: any[] = [];

mock.module("../src/api-client", () => ({
  api: {
    get: () => Promise.resolve({}),
    post: (path: string, body?: any) => { sent.push({ path, body }); return Promise.resolve({}); },
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
  ApiError: class extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; this.name = "ApiError"; } },
}));

import { ExtensionDialog } from "../src/components/ExtensionDialog";
import { useExtDialogStore } from "../src/store/ext-dialog";

const RESPOND_PATH = "/api/extensions/dialog/respond";

function lastRespond() {
  return sent.filter((s) => s.path === RESPOND_PATH).at(-1);
}

beforeEach(() => {
  sent.length = 0;
  useExtDialogStore.setState({ queue: [] });
});

describe("ExtensionDialog", () => {
  it("队列为空时不渲染弹窗", () => {
    render(<ExtensionDialog />);
    expect(screen.queryByTestId("modal-overlay")).toBeNull();
  });

  it("confirm：渲染 title/message，点「确认」POST { requestId, confirmed: true }", async () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r1", method: "confirm", title: "删除文件", message: "确定要删除吗？",
    });
    render(<ExtensionDialog />);

    expect(screen.getByText("删除文件")).toBeTruthy();
    expect(screen.getByText("确定要删除吗？")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ext-dialog-ok"));

    await waitFor(() => {
      expect(lastRespond()?.body).toEqual({ requestId: "r1", confirmed: true });
    });
    // 应答后弹出队列
    expect(useExtDialogStore.getState().queue).toHaveLength(0);
  });

  it("confirm：点「取消」POST { requestId, cancelled: true }", async () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r2", method: "confirm", title: "t", message: "m",
    });
    render(<ExtensionDialog />);

    fireEvent.click(screen.getByTestId("ext-dialog-cancel"));

    await waitFor(() => {
      expect(lastRespond()?.body).toEqual({ requestId: "r2", cancelled: true });
    });
  });

  it("select：渲染 options 按钮，点某项 POST { requestId, value: option }", async () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r3", method: "select", title: "选择方案", options: ["方案A", "方案B"],
    });
    render(<ExtensionDialog />);

    expect(screen.getByText("选择方案")).toBeTruthy();
    fireEvent.click(screen.getByText("方案B"));

    await waitFor(() => {
      expect(lastRespond()?.body).toEqual({ requestId: "r3", value: "方案B" });
    });
  });

  it("select：ESC / 点击遮罩不取消（只有「取消」按钮才取消）", async () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r4", method: "select", title: "t", options: ["A"],
    });
    render(<ExtensionDialog />);

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByTestId("modal-overlay"));

    // 两种误触路径都不应应答、弹窗仍在
    await new Promise((r) => setTimeout(r, 50));
    expect(lastRespond()).toBeUndefined();
    expect(useExtDialogStore.getState().queue).toHaveLength(1);
    expect(screen.getByTestId("ext-dialog")).toBeTruthy();

    // 只有「取消」按钮才取消
    fireEvent.click(screen.getByTestId("ext-dialog-cancel"));
    await waitFor(() => {
      expect(lastRespond()?.body).toEqual({ requestId: "r4", cancelled: true });
    });
    expect(useExtDialogStore.getState().queue).toHaveLength(0);
  });

  it("input：单行输入（placeholder）提交 POST { value }；取消 POST { cancelled: true }", async () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r5", method: "input", title: "输入名称", placeholder: "请输入…",
    });
    render(<ExtensionDialog />);

    const input = screen.getByTestId("ext-dialog-input") as HTMLInputElement;
    expect(input.placeholder).toBe("请输入…");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("ext-dialog-ok"));

    await waitFor(() => {
      expect(lastRespond()?.body).toEqual({ requestId: "r5", value: "hello" });
    });
  });

  it("editor：textarea 带 prefill，提交 POST { value: 编辑后文本 }", async () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r6", method: "editor", title: "编辑内容", prefill: "原始文本",
    });
    render(<ExtensionDialog />);

    const textarea = screen.getByTestId("ext-dialog-editor") as HTMLTextAreaElement;
    expect(textarea.value).toBe("原始文本");
    fireEvent.change(textarea, { target: { value: "改过的文本" } });
    fireEvent.click(screen.getByTestId("ext-dialog-ok"));

    await waitFor(() => {
      expect(lastRespond()?.body).toEqual({ requestId: "r6", value: "改过的文本" });
    });
  });

  it("队列按序展示：应答当前后自动展示下一个请求", async () => {
    useExtDialogStore.getState().enqueue({ requestId: "r7", method: "confirm", title: "第一个", message: "m1" });
    useExtDialogStore.getState().enqueue({ requestId: "r8", method: "confirm", title: "第二个", message: "m2" });
    render(<ExtensionDialog />);

    expect(screen.getByText("第一个")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ext-dialog-ok"));

    await waitFor(() => {
      expect(screen.getByText("第二个")).toBeTruthy();
    });
    expect(useExtDialogStore.getState().queue).toHaveLength(1);
  });
});
