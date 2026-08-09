import { test, expect } from "bun:test";
import type { ConfigEnv, ProxyOptions, UserConfig } from "vite";
import configFactory from "../vite.config";

function getProxyTarget(cfg: UserConfig): string | undefined {
  const proxy = cfg.server?.proxy?.["/file"];
  return typeof proxy === "string" ? proxy : (proxy as ProxyOptions | undefined)?.target as string | undefined;
}

test("dev server 默认把 /file 代理到 kernel 9776 端口", async () => {
  // 避免测试环境变量覆盖默认值，确保断言的是默认端口
  delete process.env.WA_PI_WS_PORT;
  const cfg = (await (configFactory as (env: ConfigEnv) => UserConfig | Promise<UserConfig>)({
    mode: "development",
    command: "serve",
  })) as UserConfig;
  expect(cfg.server).toBeDefined();
  expect(cfg.server?.proxy).toBeDefined();
  expect(cfg.server?.proxy?.["/file"]).toBeDefined();
  expect(getProxyTarget(cfg)).toBe("http://127.0.0.1:9776");
});

test("dev server 可按 WA_PI_WS_PORT 覆盖 /file 代理端口", async () => {
  process.env.WA_PI_WS_PORT = "12345";
  const cfg = (await (configFactory as (env: ConfigEnv) => UserConfig | Promise<UserConfig>)({
    mode: "development",
    command: "serve",
  })) as UserConfig;
  expect(getProxyTarget(cfg)).toBe("http://127.0.0.1:12345");
  delete process.env.WA_PI_WS_PORT;
});
