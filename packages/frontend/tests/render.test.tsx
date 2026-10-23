import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, act } from "@testing-library/react";
import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";
import { disconnectEvents } from "../src/events";

const calls: { method: string; path: string; body?: any }[] = [];

mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => { calls.push({ method: "get", path }); return Promise.resolve({}); },
    post: (path: string, body?: any) => { calls.push({ method: "post", path, body }); return Promise.resolve({}); },
    put: (path: string, body?: any) => { calls.push({ method: "put", path, body }); return Promise.resolve({}); },
    del: (path: string) => { calls.push({ method: "del", path }); return Promise.resolve({}); },
  },
  ApiError: class extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; this.name = "ApiError"; } },
}));

beforeEach(() => {
  disconnectEvents();
  calls.length = 0;
  useProjectsStore.setState({
    projects: [], sessions: [], currentProjectId: null, currentSessionId: null,
  });
});

test("App 渲染（empty 态冒烟）", async () => {
  render(<App />);
  await act(async () => {});
  expect(screen.getByTestId("empty-state")).toBeTruthy();
});
