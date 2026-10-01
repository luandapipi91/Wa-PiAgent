// commands store 的「两份清单」契约（回归：/mcp 假用户气泡，任务 13 报告 §3）。
//
// / 菜单用 `commands`（展示层过滤：skill 走 $ 菜单、插件命令只显示已开启、pi 内置扩展命令有专属
// 管理页）；`allCommands` 是全量（供 Composer 判定「这条 slash 会不会被 pi 拦截执行」）。
// 内置扩展命令（builtinExtension，如 /mcp）只该从前者消失——它必须留在后者里，否则前端会
// 乐观插入一条 pi 从未收到的用户消息。
import { expect, mock, test } from "bun:test";

const getMock = mock(async () => ({
  commands: [
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
  ],
}));
mock.module("../api-client", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    get: getMock,
    post: async () => ({}),
    put: async () => ({}),
    del: async () => ({}),
  },
}));

const { useCommandsStore } = await import("./commands");

const names = (list: { name: string }[]) => list.map((c) => c.name);

/** 让 load() 的 .then 跑完 */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

test("/ 菜单隐藏内置扩展命令与已关闭的插件命令；allCommands 保留（拦截判定依据）", async () => {
  useCommandsStore.getState().load("s1");
  await flush();

  // 展示层：内置扩展命令（有专属管理页）、已关闭的插件命令、skill、__! 内部命令都不出现
  expect(names(useCommandsStore.getState().commands)).toEqual(["uidemo", "review"]);

  // 拦截判定用全量：内置扩展命令**必须**在（pi 会拦截执行它们），已关闭的插件命令也在
  //（开关只影响 / 菜单展示，pi 只要注册了就仍会拦截执行）
  expect(names(useCommandsStore.getState().allCommands)).toEqual([
    "uidemo",
    "goal",
    "mcp",
    "llama",
    "review",
    "skill:x",
  ]);
});
