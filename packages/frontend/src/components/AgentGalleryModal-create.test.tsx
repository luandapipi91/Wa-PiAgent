import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentGalleryModal } from "./AgentGalleryModal";

const getMock = mock(); const postMock = mock(); const delMock = mock();
mock.module("../api-client", () => ({ api: { get: getMock, post: postMock, put: mock(), del: delMock } }));

import { useAgentsStore } from "../store/agents";

beforeEach(() => {
  // 防御：全量（非 --isolate）运行时 clipboard.test.ts 会把 globalThis.window 换成 {}
  // 且不恢复，导致 Modal 的 window.addEventListener 崩溃；从 document.defaultView 还原
  if (typeof window.addEventListener !== "function" && (document as any).defaultView) {
    (globalThis as any).window = (document as any).defaultView;
  }
  getMock.mockReset(); postMock.mockReset();
  getMock.mockImplementation(async (path: string) =>
    path === "/api/agents/presets" ? { presets: [] } : {});
  useAgentsStore.setState({ list: [] } as any);
});

test("点击「新建」打开 AgentCreatePicker（不再是 inline 输入框）", async () => {
  render(<AgentGalleryModal onClose={() => {}} onChatWith={() => {}} onEdit={() => {}} onCreated={() => {}} />);
  fireEvent.click(await screen.findByTestId("gallery-create"));
  expect(await screen.findByTestId("agent-create-picker")).toBeTruthy();
  expect(screen.queryByTestId("gallery-create-input")).toBeNull();
});

test("创建成功回调 onCreated 并关闭面板", async () => {
  const created: string[] = [];
  postMock.mockImplementation(async () => ({ type: "agent:created", agent: {} }));
  render(<AgentGalleryModal onClose={() => {}} onChatWith={() => {}} onEdit={() => {}} onCreated={n => created.push(n)} />);
  fireEvent.click(await screen.findByTestId("gallery-create"));
  fireEvent.click(await screen.findByTestId("picker-tab-blank"));
  fireEvent.change(await screen.findByTestId("blank-name-input"), { target: { value: "苏念安" } });
  fireEvent.click(screen.getByTestId("blank-create-btn"));
  await new Promise(r => setTimeout(r, 0));
  expect(created).toEqual(["苏念安"]);
  expect(screen.queryByTestId("agent-create-picker")).toBeNull();
});
