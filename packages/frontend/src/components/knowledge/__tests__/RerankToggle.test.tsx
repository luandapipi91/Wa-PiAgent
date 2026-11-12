import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { KnowledgePage, shouldPollRerank, RERANK_IDLE_POLL_MAX } from "../KnowledgePage";
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

  test("诊断也收进「更多」菜单：页头无诊断按钮，菜单内入口可打开体检弹窗", async () => {
    render(<KnowledgePage />);
    await screen.findByTestId("kb-more-menu");
    expect(screen.queryByTestId("kb-doctor-open")).toBeNull(); // 页头已无
    fireEvent.click(screen.getByTestId("kb-more-menu"));
    const entry = await screen.findByTestId("kb-doctor-open");
    fireEvent.click(entry);
    await screen.findByTestId("kb-doctor-modal");
    expect(screen.queryByTestId("kb-more-popup")).toBeNull(); // 开弹窗前先收菜单
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

  test("开关已开但模型尚未加载时，状态不能显示「未开启」（这是自相矛盾的展示）", async () => {
    rerankReply = { type: "knowledge:rerank", enabled: true, status: "idle", model: "X" };
    useKnowledgeStore.setState({ rerank: { enabled: true, status: "idle", model: "X" } } as never);
    await openMenu();
    const status = await screen.findByTestId("kb-rerank-status");
    expect(status.textContent).not.toContain("未开启");
    expect(status.textContent).toContain("待加载");
  });

  test("开关未开启时状态仍显示「未开启」", async () => {
    rerankReply = { type: "knowledge:rerank", enabled: false, status: "idle", model: "X" };
    useKnowledgeStore.setState({ rerank: { enabled: false, status: "idle", model: "X" } } as never);
    await openMenu();
    const status = await screen.findByTestId("kb-rerank-status");
    expect(status.textContent).toBe("未开启");
  });

  test("轮询条件：已开启但仍在 idle（重启恢复窗口）要继续轮询，未开启不轮询", () => {
    // 下载中跟进度
    expect(shouldPollRerank({ enabled: true, status: "downloading" }, 0)).toBe(true);
    // 已开启但模型还没加载起来 → 启动恢复中，得跟着等终态（否则页面会一直停在旧快照）
    expect(shouldPollRerank({ enabled: true, status: "idle" }, 0)).toBe(true);
    // 未开启没有终态可等
    expect(shouldPollRerank({ enabled: false, status: "idle" }, 0)).toBe(false);
    // 终态不再轮询
    expect(shouldPollRerank({ enabled: true, status: "ready" }, 0)).toBe(false);
    expect(shouldPollRerank({ enabled: true, status: "failed" }, 0)).toBe(false);
  });

  test("轮询条件：idle 等待有上限（旧版内核永远不加载时不无限请求）", () => {
    expect(shouldPollRerank({ enabled: true, status: "idle" }, RERANK_IDLE_POLL_MAX - 1)).toBe(true);
    expect(shouldPollRerank({ enabled: true, status: "idle" }, RERANK_IDLE_POLL_MAX)).toBe(false);
    // 下载中不受该上限约束（大模型慢网可能很久）
    expect(shouldPollRerank({ enabled: true, status: "downloading" }, RERANK_IDLE_POLL_MAX * 10)).toBe(true);
  });

  test("点击菜单外部关闭菜单", async () => {
    await openMenu();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("kb-more-popup")).toBeNull());
  });
});
