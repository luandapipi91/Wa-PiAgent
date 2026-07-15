import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpStore } from "../src/mcp-store";
import type { ProjectEntity } from "@hiagent/shared";

const TMP = join(import.meta.dir, "mcp-test-" + Date.now());
const PROJECT_CWD = join(TMP, "my-project");
const MOCK_PROJECT: ProjectEntity = { id: "p1", name: "my-project", cwd: PROJECT_CWD, createdAt: 1 };

const mockProjectStore = {
  load: async () => ({ projects: [MOCK_PROJECT], sessions: [] as any[] }),
} as any;

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  await mkdir(PROJECT_CWD, { recursive: true });
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

function createStore() {
  return new McpStore({ hiagentDir: TMP, projectStore: mockProjectStore });
}

// ===== resolveConfigPath =====

test("resolveConfigPath: 无 projectId 返回全局路径", async () => {
  const store = createStore() as any;
  const path = await store.resolveConfigPath(undefined);
  expect(path).toBe(join(TMP, "mcp.json"));
});

test("resolveConfigPath: 带 projectId 返回项目路径", async () => {
  const store = createStore() as any;
  const path = await store.resolveConfigPath("p1");
  expect(path).toBe(join(PROJECT_CWD, ".mcp.json"));
});

test("resolveConfigPath: projectId 不存在抛错", async () => {
  const store = createStore() as any;
  await expect(store.resolveConfigPath("nope")).rejects.toThrow();
});

// ===== readConfig =====

test("readConfig: 文件不存在返回空结构", async () => {
  const store = createStore() as any;
  const cfg = await store.readConfig("/nope/not-exists.json");
  expect(cfg).toEqual({ mcpServers: {} });
});

test("readConfig: 正常解析", async () => {
  const p = join(TMP, "test.json");
  await writeFile(p, JSON.stringify({ mcpServers: { s1: { command: "npx", args: ["-y", "test"] } } }));
  const store = createStore() as any;
  const cfg = await store.readConfig(p);
  expect(cfg.mcpServers["s1"].command).toBe("npx");
  expect(cfg.mcpServers["s1"].args).toEqual(["-y", "test"]);
});

test("readConfig: JSON 解析失败抛错", async () => {
  const p = join(TMP, "bad.json");
  await writeFile(p, "{not valid json");
  const store = createStore() as any;
  await expect(store.readConfig(p)).rejects.toThrow();
});

// ===== writeConfig =====

test("writeConfig: 写入后读取一致", async () => {
  const store = createStore() as any;
  const p = join(TMP, "write-test.json");
  await store.writeConfig(p, { mcpServers: { "chrome": { command: "npx", args: ["-y", "chrome-mcp"] } } });
  const read = JSON.parse(readFileSync(p, "utf8"));
  expect(read.mcpServers.chrome.command).toBe("npx");
});

test("writeConfig: 父目录不存在时自动创建", async () => {
  const store = createStore() as any;
  const p = join(TMP, "deep", "nested", "cfg.json");
  await store.writeConfig(p, { mcpServers: {} });
  const read = JSON.parse(readFileSync(p, "utf8"));
  expect(read.mcpServers).toEqual({});
});

// ===== list =====

test("list: 全局配置返回 servers 数组", async () => {
  const globalPath = join(TMP, "mcp.json");
  await writeFile(globalPath, JSON.stringify({
    mcpServers: {
      "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"], lifecycle: "lazy" },
      "figma": { url: "http://localhost:3845/mcp", auth: "oauth" },
    },
  }));
  const store = createStore();
  const servers = await store.list();
  expect(servers.length).toBe(2);
  expect(servers[0].name).toBe("chrome-devtools");
  expect(servers[1].name).toBe("figma");
});

test("list: 文件不存在返回空数组", async () => {
  const store = createStore();
  const servers = await store.list();
  expect(servers).toEqual([]);
});

test("list: 项目配置返回 servers 数组", async () => {
  const projectPath = join(PROJECT_CWD, ".mcp.json");
  await writeFile(projectPath, JSON.stringify({
    mcpServers: { "project-server": { command: "node", args: ["server.js"] } },
  }));
  const store = createStore();
  const servers = await store.list("p1");
  expect(servers.length).toBe(1);
  expect(servers[0].name).toBe("project-server");
});

// ===== save =====

test("save: 新增 server", async () => {
  const store = createStore();
  await store.save({ name: "test-server", command: "echo", args: ["hello"] });
  const servers = await store.list();
  expect(servers.length).toBe(1);
  expect(servers[0].name).toBe("test-server");
});

test("save: 编辑 server", async () => {
  const store = createStore();
  await store.save({ name: "test-server", command: "echo", args: ["hello"] });
  await store.save({ name: "test-server", command: "echo", args: ["world"] });
  const servers = await store.list();
  expect(servers[0].args).toEqual(["world"]);
});

test("save: 改名 server (originalName)", async () => {
  const store = createStore();
  await store.save({ name: "old-name", command: "echo", args: [] });
  await store.save({ name: "new-name", command: "echo", args: [] }, undefined, "old-name");
  const servers = await store.list();
  expect(servers.length).toBe(1);
  expect(servers[0].name).toBe("new-name");
});

test("save: 传 originalName 但服务器不存在抛错", async () => {
  const store = createStore();
  // originalName 指向不存在的服务器，应抛错
  await expect(store.save({ name: "test", command: "echo" }, undefined, "nope")).rejects.toThrow();
});

test("save: 传 originalName 与 config.name 相同应成功", async () => {
  const store = createStore();
  await store.save({ name: "same-server", command: "echo", args: ["v1"] });
  // originalName 与 name 相同，应验证存在后直接覆盖
  await store.save({ name: "same-server", command: "echo", args: ["v2"] }, undefined, "same-server");
  const servers = await store.list();
  expect(servers.length).toBe(1);
  expect(servers[0].args).toEqual(["v2"]);
});

// ===== delete =====

test("delete: 删除 server", async () => {
  const store = createStore();
  await store.save({ name: "a", command: "echo" });
  await store.save({ name: "b", command: "echo" });
  await store.delete("a");
  const servers = await store.list();
  expect(servers.length).toBe(1);
  expect(servers[0].name).toBe("b");
});

test("delete: 删除不存在的 server 抛错", async () => {
  const store = createStore();
  await expect(store.delete("nope")).rejects.toThrow();
});
