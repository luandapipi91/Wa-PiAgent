// KnowledgePage 布局回归：「+ 新建知识库」与页面标题同一行。
// 注：仓库无 vitest/jest-dom，沿用 bun:test + @testing-library/react 约定
// （断言 toBeTruthy 而非 toBeInTheDocument）。
// mock api-client：KnowledgePage mount 即拉清单（GET /api/knowledge）。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, act, cleanup } from "@testing-library/react";
import { KnowledgePage } from "../KnowledgePage";
import { useKnowledgeStore } from "../../../store/knowledge";

mock.module("../../../api-client", () => ({
  api: {
    get: mock(async () => ({ type: "knowledge:list", kbs: [] })),
    post: mock(async () => ({})),
    put: mock(async () => ({})),
    del: mock(async () => ({})),
  },
}));

// mount 时的清单拉取是异步 setState：flush 一次避免 act 警告
const flushLoad = () => act(async () => {});

beforeEach(() => {
  cleanup();
  useKnowledgeStore.setState({
    kbs: [],
    loading: false,
    loaded: false,
    progress: {},
  });
});

test("「+ 新建知识库」在页面标题所在行内（同一标题栏），不单独占一行工具栏", async () => {
  render(<KnowledgePage />);
  const heading = screen.getByRole("heading", { name: /知识库/ });
  const button = screen.getByTestId("kb-add-button");
  // 同一行 = 同一父容器：旧实现按钮挂在标题栏下方的工具栏 div，标题栏容器不含它
  expect(heading.parentElement?.contains(button)).toBe(true);
  await flushLoad();
});
