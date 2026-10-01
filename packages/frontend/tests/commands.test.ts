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

// =====「两份清单」契约（回归：/mcp 假用户气泡，任务 13 报告 §3）=====
//
// / 菜单用 `commands`（展示层过滤：skill 走 $ 菜单、插件命令只显示已开启、pi 内置扩展命令有专属
// 管理页）；`allCommands` 是全量（供 Composer 判定「这条 slash 会不会被 pi 拦截执行」）。
// 内置扩展命令（builtinExtension，如 /mcp）只该从前者消失——它必须留在后者里，否则前端会
// 乐观插入一条 pi 从未收到的用户消息。
test("/ 菜单隐藏内置扩展命令与已关闭的插件命令；allCommands 保留（拦截判定依据）", async () => {
  mockData.commands = [
    {
      name: "uidemo",
      source: "extension",
      packageName: "ext-ui-bridge-demo",
      enabled: true,
    },
    { name: "goal", source: "extension", packageName: "goal-ext", enabled: false },
    { name: "mcp", source: "extension", builtinExtension: true },
    { name: "llama", source: "extension", builtinExtension: true },
    { name: "review", source: "prompt" },
    { name: "skill:x", source: "skill" },
    { name: "__!wa_pi_reload", source: "extension" },
  ];
  await loadAndSettle();

  // 展示层：内置扩展命令（有专属管理页）、已关闭的插件命令、skill、__! 内部命令都不出现
  expect(useCommandsStore.getState().commands.map((c) => c.name)).toEqual([
    "uidemo",
    "review",
  ]);

  // 拦截判定用全量：内置扩展命令**必须**在（pi 会拦截执行它们），已关闭的插件命令也在
  //（开关只影响 / 菜单展示，pi 只要注册了就仍会拦截执行）
  expect(useCommandsStore.getState().allCommands.map((c) => c.name)).toEqual([
    "uidemo",
    "goal",
    "mcp",
    "llama",
    "review",
    "skill:x",
  ]);
});
