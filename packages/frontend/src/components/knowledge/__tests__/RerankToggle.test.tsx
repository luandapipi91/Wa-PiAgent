import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { KnowledgePage } from "../KnowledgePage";
import { useKnowledgeStore } from "../../../store/knowledge";
import type { KbInfo } from "@wa-pi/shared";

const putCalls: Array<[string, unknown]> = [];
let rerankReply: Record<string, unknown> = { type: "knowledge:rerank", enabled: false, status: "idle", model: "Xenova/ms-marco-MiniLM-L-4-v2" };

mock.module("../../../api-client", () => ({
  api: {
    get: mock(async (path: string) => {
      if (path === "/api/knowledge/rerank") return rerankReply;
      if (path === "/api/knowledge/doctor") return { type: "knowledge:doctor", report: { health_score: 100, summary: "健康", issues: [], diagnostics: [] } };
      return { type: "knowledge:list", kbs: [] };
    }),
    post: mock(async () => ({})),
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
  useKnowledgeStore.setState({ kbs: [], progress: {}, loading: false, loaded: true, error: null });
});

describe("rerank 开关", () => {
  test("默认关闭显示开启开关；点击后 PUT {enabled:true}", async () => {
    render(<KnowledgePage />);
    const toggle = await screen.findByTestId("kb-rerank-toggle");
    fireEvent.click(toggle);
    await waitFor(() => expect(putCalls.at(-1)?.[0]).toBe("/api/knowledge/rerank"));
    expect(putCalls.at(-1)?.[1]).toEqual({ enabled: true });
  });

  test("下载中展示进度百分比", async () => {
    rerankReply = { type: "knowledge:rerank", enabled: true, status: "downloading", model: "X", progress: 42 };
    useKnowledgeStore.setState({
      rerank: { enabled: true, status: "downloading", model: "X", progress: 42 },
    } as never);
    render(<KnowledgePage />);
    await waitFor(() => expect(screen.getByTestId("kb-rerank-status").textContent).toContain("42%"));
  });
});
