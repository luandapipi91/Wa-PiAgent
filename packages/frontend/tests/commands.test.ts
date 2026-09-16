import { test, expect, beforeEach, mock } from "bun:test";
import type { CommandInfo } from "@wa-pi/shared";
import { useCommandsStore } from "../src/store/commands";

// store 的 load 会触发 api.get（真实 fetch），happy-dom 在 about:blank 下对相对 URL
// 抛 NotSupportedError。mock 掉 api-client，返回可注入的 commands 数据，
// 断言聚焦于 store 过滤逻辑。
const mockData: { commands: CommandInfo[] } = { commands: [] };

mock.module("../src/api-client", () => ({
  api: {
    get: () => Promise.resolve({ commands: mockData.commands }),
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
}));

beforeEach(() => {
  mockData.commands = [];
  useCommandsStore.setState({ commands: [], allCommands: [], loading: false });
});

/** 触发 load 并等待 api.get 的 .then 微任务执行完 */
async function loadAndSettle(sessionId = "s1") {
  useCommandsStore.getState().load(sessionId);
  await Promise.resolve();
  await Promise.resolve();
}

test("extension 命令 enabled === true 保留在 / 菜单", async () => {
  mockData.commands = [
    { name: "goal", description: "设定目标", source: "extension", packageName: "pkg-a", enabled: true },
  ];
  await loadAndSettle();
  expect(useCommandsStore.getState().commands).toHaveLength(1);
  expect(useCommandsStore.getState().commands[0].name).toBe("goal");
  expect(useCommandsStore.getState().loading).toBe(false);
});

test("extension 命令 enabled === false 被过滤", async () => {
  mockData.commands = [
    { name: "goal", description: "设定目标", source: "extension", packageName: "pkg-a", enabled: false },
  ];
  await loadAndSettle();
  expect(useCommandsStore.getState().commands).toEqual([]);
});

test("extension 命令 enabled 缺省（undefined）被过滤", async () => {
  mockData.commands = [
    { name: "goal", description: "设定目标", source: "extension", packageName: "pkg-a" },
  ];
  await loadAndSettle();
  expect(useCommandsStore.getState().commands).toEqual([]);
});

test("prompt 命令不受 enabled 过滤影响（保留）", async () => {
  mockData.commands = [
    { name: "myreview", description: "我的审查", source: "prompt" },
  ];
  await loadAndSettle();
  expect(useCommandsStore.getState().commands.map((c) => c.name)).toEqual(["myreview"]);
});

test("builtin 命令不受 enabled 过滤影响（保留）", async () => {
  mockData.commands = [
    { name: "compact", description: "压缩上下文", source: "builtin" },
  ];
  await loadAndSettle();
  expect(useCommandsStore.getState().commands.map((c) => c.name)).toEqual(["compact"]);
});

test("skill 命令仍被过滤（技能走 $ 菜单）", async () => {
  mockData.commands = [
    { name: "myskill", description: "技能", source: "skill" },
  ];
  await loadAndSettle();
  expect(useCommandsStore.getState().commands).toEqual([]);
});

test("混合场景：只保留 enabled 的 extension + 全部 prompt/builtin，过滤 skill 与未开启 extension", async () => {
  mockData.commands = [
    { name: "goal", source: "extension", packageName: "pkg-a", enabled: true },
    { name: "review", source: "extension", packageName: "pkg-b", enabled: false },
    { name: "old", source: "extension", packageName: "pkg-c" },
    { name: "myreview", source: "prompt" },
    { name: "compact", source: "builtin" },
    { name: "myskill", source: "skill" },
  ];
  await loadAndSettle();
  expect(useCommandsStore.getState().commands.map((c) => c.name)).toEqual([
    "goal",
    "myreview",
    "compact",
  ]);
});

test("allCommands 保留未过滤全量（含关闭开关的 extension 与 skill，供发送判定用）", async () => {
  mockData.commands = [
    { name: "goal", source: "extension", packageName: "pkg-a", enabled: true },
    { name: "review", source: "extension", packageName: "pkg-b", enabled: false },
    { name: "myreview", source: "prompt" },
    { name: "myskill", source: "skill" },
  ];
  await loadAndSettle();
  // / 菜单只剩开启的 extension + prompt
  expect(useCommandsStore.getState().commands.map((c) => c.name)).toEqual(["goal", "myreview"]);
  // allCommands 全量保留（关闭开关的 review、skill 都在）
  expect(useCommandsStore.getState().allCommands.map((c) => c.name)).toEqual([
    "goal",
    "review",
    "myreview",
    "myskill",
  ]);
});
