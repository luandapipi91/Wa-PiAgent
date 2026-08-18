// vite.config 的 define 注入逻辑测试（打包版「前端查错目录 → 默认工作区文件树空白」的根因回归测试）。
// 背景：.env 里 WA_PI_DIR=${HOME}/.pi/agent-dev 是 dev 专用隔离目录，vite loadEnv 会读到它。
// 若生产构建也注入该值，打包版前端 bundle 的 WA_PI_DIR=~/.pi/agent-dev，而打包版 kernel
// 运行时无 .env、用默认 ~/.pi/agent → 前端 resolveSessionCwd 拼出的会话目录查错位置 →
// listDir 返回 fs:error → ExplorerPanel 静默 [] → 文件树空白。
import { test, expect } from "bun:test";
import { resolveInjectedValue } from "./vite.config";

const devEnvVars = {
  WA_PI_DIR: "${HOME}/.pi/agent-dev",
  HOME: "/Users/pipi",
};

test("development：WA_PI_DIR 从 .env 注入（与 dev kernel 的 bun --env-file=.env 一致）", () => {
  expect(resolveInjectedValue("WA_PI_DIR", "development", {}, devEnvVars)).toBe(
    "${HOME}/.pi/agent-dev",
  );
});

test("production：不注入 .env 的 dev WA_PI_DIR（打包版前端回退默认 ~/.pi/agent，与 kernel 一致）", () => {
  expect(
    resolveInjectedValue("WA_PI_DIR", "production", {}, devEnvVars),
  ).toBeUndefined();
});

test("production：即使 process.env 被 bun 自动加载 .env 污染（值为 dev 目录），也不注入 WA_PI_DIR", () => {
  expect(
    resolveInjectedValue(
      "WA_PI_DIR",
      "production",
      { WA_PI_DIR: "/Users/pipi/.pi/agent-dev" },
      devEnvVars,
    ),
  ).toBeUndefined();
});

test("HOME：production 也注入（来自 process.env，shared 用它拼默认 ~/.pi/agent）", () => {
  expect(
    resolveInjectedValue(
      "HOME",
      "production",
      { HOME: "/Users/pipi" },
      devEnvVars,
    ),
  ).toBe("/Users/pipi");
});
