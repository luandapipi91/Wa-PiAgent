// vite.config 的 define 注入逻辑测试（打包版「前端查错目录 → 默认工作区文件树空白」的根因回归测试）。
// 背景：.env 里 WA_PI_DIR=${HOME}/.pi/agent-dev 是 dev 专用隔离目录，vite loadEnv 会读到它。
// 若生产构建也注入该值，打包版前端 bundle 的 WA_PI_DIR=~/.pi/agent-dev，而打包版 kernel
// 运行时无 .env、用默认 ~/.pi/agent → 前端 resolveSessionCwd 拼出的会话目录查错位置 →
// listDir 返回 fs:error → ExplorerPanel 静默 [] → 文件树空白。
import { test, expect } from "bun:test";
import { resolveInjectedValue, resolveWsPortDefine } from "./vite.config";

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

test("production：机器相关路径（HOME/USERPROFILE/WA_PI_DIR）全部不注入（打包版 bundle 不得携带构建机家目录）", () => {
  // v0.2.7 只挡了 WA_PI_DIR，漏掉 HOME/USERPROFILE：打包机是 macOS（HOME=/Users/pipi）时，
  // 前端 constants.ts 用 `${HOME}/.pi/agent` 回退拼出 /Users/pipi/.pi/agent/workdir，
  // 在 Windows 上请求该路径 → listDir ENOENT → 默认工作区文件树空白。
  // 前端应使用 kernel 持久化的 __system__.cwd（运行时本机路径），故机器路径一律不注入。
  expect(
    resolveInjectedValue(
      "HOME",
      "production",
      { HOME: "/Users/pipi", USERPROFILE: "C:\\Users\\co" },
      devEnvVars,
    ),
  ).toBeUndefined();
  expect(
    resolveInjectedValue(
      "USERPROFILE",
      "production",
      { HOME: "/Users/pipi", USERPROFILE: "C:\\Users\\co" },
      devEnvVars,
    ),
  ).toBeUndefined();
  expect(
    resolveInjectedValue(
      "WA_PI_DIR",
      "production",
      { WA_PI_DIR: "/Users/pipi/.pi/agent-dev" },
      devEnvVars,
    ),
  ).toBeUndefined();
});

test("production：WA_PI_WS_PORT 恒注入默认 9776，不读打包机 process.env / .env", () => {
  // 打包机 .env 里的 dev 端口若进 bundle，安装版前端会连错端口。
  expect(
    resolveWsPortDefine(
      "production",
      { WA_PI_WS_PORT: "19976" },
      { WA_PI_WS_PORT: "29976" },
    ),
  ).toBe("9776");
});

test("development：WA_PI_WS_PORT 优先 process.env，其次 .env，兜底 9776", () => {
  expect(
    resolveWsPortDefine("development", { WA_PI_WS_PORT: "19976" }, {}),
  ).toBe("19976");
  expect(
    resolveWsPortDefine("development", {}, { WA_PI_WS_PORT: "29976" }),
  ).toBe("29976");
  expect(resolveWsPortDefine("development", {}, {})).toBe("9776");
});
