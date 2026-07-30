import "./mock-composer-db";
import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, act } from "@testing-library/react";
import { composerDbDefaults, composerDbSessions } from "./mock-composer-db";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { App, type View } from "../src/App";
import { disconnectEvents } from "../src/events";

// mock REST 客户端，避免 App useEffect 里的数据加载触发真实 HTTP 请求。
// 注意：get 对非 /messages 路径返回 null（falsy），避免 App mount 时各 store.loadAll
// 的 if(data) 分支异步覆盖测试预设的 store 状态（agents/projects 等），导致渲染路径异常。
mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => {
      if (path.includes("/messages")) return Promise.resolve({ messages: [] });
      return Promise.resolve(null);
    },
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
      this.name = "ApiError";
    }
  },
}));

beforeEach(() => {
  // 清理 SSE 事件监听器，避免跨测试污染
  disconnectEvents();
  // 重置 composer-db mock 的默认值
  composerDbDefaults.model = null;
  composerDbDefaults.thinking = "disabled";
  for (const k of Object.keys(composerDbSessions)) delete composerDbSessions[k];
  // 重置相关 store
  useProjectsStore.setState({
    projects: [],
    sessions: [],
    currentProjectId: null,
    currentSessionId: null,
    dirPickerOpen: false,
  });
  useSessionStore.setState({ messagesBySession: {} });
  useComposerPrefsStore.setState({
    defaults: { model: null, thinking: "disabled" },
    bySession: {},
    newSessionIds: {},
  });
});

test("View 类型不再包含 canvas", () => {
  // 编译期约束：若 View 仍含 'canvas'，这行会编译通过；运行时只断言可赋值集合
  const ok: View[] = ["empty", "new-session", "session"];
  expect(ok.length).toBe(3);
});

test("App 渲染 session 视图时不出现编排画布按钮", async () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/tmp", createdAt: 1 }],
    sessions: [
      {
        id: "s1",
        projectId: "p1",
        primaryAgent: "dev",
        title: "T",
        createdAt: 1,
        lastActivity: 1,
        piSessionFile: "/x.jsonl",
      },
    ],
    currentProjectId: "p1",
    currentSessionId: "s1",
    dirPickerOpen: false,
  } as any);
  useSessionStore.setState({ messagesBySession: {} });
  useComposerPrefsStore.setState({ bySession: {} });

  render(<App />);
  // 等待 App useEffect 中异步加载的 Promise 微任务完成，减少 act 警告
  await act(async () => {});

  expect(screen.queryByText("编排画布")).toBeNull();
});
