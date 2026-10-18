import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  loadWebSearchSettings,
  saveWebSearchSettings,
  WEB_SEARCH_DEFAULTS,
} from "../src/settings-store";

// 互联网搜索设置（DeepSeek 搜索/抓取）：store 层读写 settings.json 的 webSearch 字段。
// 临时目录隔离，不碰真实 ~/.pi/agent/settings.json。

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "settings-websearch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("默认值：两个开关开启、apiKey 为空（没配 key 也能开工具，调用时引导配置）", async () => {
  expect(await loadWebSearchSettings(join(dir, "settings.json"))).toEqual({
    ...WEB_SEARCH_DEFAULTS,
  });
  expect(WEB_SEARCH_DEFAULTS).toEqual({
    searchEnabled: true,
    fetchEnabled: true,
    apiKey: "",
  });
});

test("save 后 load 往返一致", async () => {
  const file = join(dir, "settings.json");
  await saveWebSearchSettings(
    { searchEnabled: false, fetchEnabled: true, apiKey: "sk-deepseek-1" },
    file,
  );
  expect(await loadWebSearchSettings(file)).toEqual({
    searchEnabled: false,
    fetchEnabled: true,
    apiKey: "sk-deepseek-1",
  });
});

test("save 时 apiKey 传空串保留已存值（编辑开关不冲掉 key，对齐 share token 语义）", async () => {
  const file = join(dir, "settings.json");
  await saveWebSearchSettings(
    { searchEnabled: true, fetchEnabled: true, apiKey: "sk-keep-me" },
    file,
  );
  await saveWebSearchSettings(
    { searchEnabled: false, fetchEnabled: false, apiKey: "" },
    file,
  );
  const loaded = await loadWebSearchSettings(file);
  expect(loaded.apiKey).toBe("sk-keep-me");
  expect(loaded.searchEnabled).toBe(false);
  expect(loaded.fetchEnabled).toBe(false);
});

test("与 share 等其他设置字段互不干扰（read-modify-write 保留未知字段）", async () => {
  const file = join(dir, "settings.json");
  await saveWebSearchSettings(
    { searchEnabled: true, fetchEnabled: true, apiKey: "sk-x" },
    file,
  );
  // 模拟其他域写入
  const raw = JSON.parse(await require("node:fs/promises").readFile(file, "utf8"));
  raw.share = { token: "tk_other" };
  raw.customField = { keep: true };
  await require("node:fs/promises").writeFile(file, JSON.stringify(raw));
  await saveWebSearchSettings(
    { searchEnabled: false, fetchEnabled: true, apiKey: "" },
    file,
  );
  const raw2 = JSON.parse(await require("node:fs/promises").readFile(file, "utf8"));
  expect(raw2.share).toEqual({ token: "tk_other" });
  expect(raw2.customField).toEqual({ keep: true });
  expect(raw2.webSearch.searchEnabled).toBe(false);
});
