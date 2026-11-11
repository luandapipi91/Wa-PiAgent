import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { KnowledgePage } from "../KnowledgePage";
import { useKnowledgeStore } from "../../../store/knowledge";

const putCalls: Array<[string, unknown]> = [];
const postCalls: string[] = [];
let rerankReply: Record<string, unknown> = {
  type: "knowledge:rerank",
  enabled: false,
  status: "idle",
  model: "Xenova/ms-marco-MiniLM-L-4-v2",
};

mock.module("../../../api-client", () => ({
  api: {
    get: mock(async (path: string) => {
      if (path === "/api/knowledge/rerank") return rerankReply;
      if (path === "/api/knowledge/doctor")
        return { type: "knowledge:doctor", report: { health_score: 100, summary: "健康", issues: [], diagnostics: [] } };
      return { type: "knowledge:list", kbs: [] };
    }),
    post: mock(async (path: string) => {
      postCalls.push(path);
      return {};
    }),
    put: mock(async (path: string, body?: unknown) => {
      putCalls.push([path, body]);
      return rerankReply;
    }),
    del: mock(async () => ({})),
  },
}));

beforeEach(() => {
  cleanup();
  putCalls.length = 0;
  postCalls.length = 0;
  useKnowledgeStore.setState({ kbs: [], progress: {}, loading: false, loaded: true, error: null });
});

const openMenu = async () => {
  render(<KnowledgePage />);
  fireEvent.click(await screen.findByTestId("kb-more-menu"));
  return screen.findByTestId("kb-more-popup");
};

describe("深度重排（页头「更多」菜单内）", () => {
  test("默认不在页头平铺：需点「更多」才出现开关", async () => {
    render(<KnowledgePage />);
    await screen.findByTestId("kb-more-menu");
    expect(screen.queryByTestId("kb-more-popup")).toBeNull();
    expect(screen.queryByTestId("kb-rerank-toggle")).toBeNull();
  });

  test("开关是 switch（role=switch + aria-checked），点击后 PUT {enabled:true}", async () => {
    await openMenu();
    const toggle = await screen.findByTestId("kb-rerank-toggle");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(putCalls.at(-1)?.[0]).toBe("/api/knowledge/rerank"));
    expect(putCalls.at(-1)?.[1]).toEqual({ enabled: true });
  });

  test("下载中展示进度百分比", async () => {
    rerankReply = { type: "knowledge:rerank", enabled: true, status: "downloading", model: "X", progress: 42 };
    useKnowledgeStore.setState({
      rerank: { enabled: true, status: "downloading", model: "X", progress: 42 },
    } as never);
    await openMenu();
    await waitFor(() => expect(screen.getByTestId("kb-rerank-status").textContent).toContain("42%"));
  });

  test("失败时菜单内展示重试并调用 prepare", async () => {
    rerankReply = { type: "knowledge:rerank", enabled: true, status: "failed", model: "X" };
    useKnowledgeStore.setState({ rerank: { enabled: true, status: "failed", model: "X" } } as never);
    await openMenu();
    const retry = await screen.findByTestId("kb-rerank-retry");
    fireEvent.click(retry);
    await waitFor(() => expect(postCalls.at(-1)).toBe("/api/knowledge/rerank/retry"));
  });

  test("点击菜单外部关闭菜单", async () => {
    await openMenu();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("kb-more-popup")).toBeNull());
  });
});
