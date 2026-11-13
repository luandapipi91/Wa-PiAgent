import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpFile } from "../mcp-file";
import { builtinAgentBrowserEntry } from "../mcp-builtin";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "wa-pi-builtin-"));
  const globalPath = join(dir, "mcp.json");
  const file = new McpFile({ globalPath, projectPathFor: async () => join(dir, "p.json") });
  return { dir, globalPath, file };
}

test("缺失时写入内置条目（含 description 与 env 模板）", async () => {
  const { globalPath, file } = await setup();
  await file.ensureBuiltin(builtinAgentBrowserEntry("/abs/agent-browser"));
  const raw = JSON.parse(await readFile(globalPath, "utf8"));
  expect(raw.mcpServers["agent-browser"]).toMatchObject({
    command: "/abs/agent-browser",
    args: ["mcp"],
    exposure: "direct",
    description: "浏览器自动化（agent-browser）",
    env: { AGENT_BROWSER_SESSION: "${WA_PI_BROWSER_SESSION}", AGENT_BROWSER_IDLE_TIMEOUT_MS: "600000" },
  });
});

test("已存在时保留 enabled，纠正 command/args", async () => {
  const { globalPath, file } = await setup();
  await writeFile(globalPath, JSON.stringify({ mcpServers: { "agent-browser": { command: "/old", enabled: false } } }));
  await file.ensureBuiltin(builtinAgentBrowserEntry("/new"));
  const entry = JSON.parse(await readFile(globalPath, "utf8")).mcpServers["agent-browser"];
  expect(entry.command).toBe("/new");
  expect(entry.enabled).toBe(false);
});

test("delete / save 内置名抛 mcp.builtinProtected", async () => {
  const { file } = await setup();
  await file.ensureBuiltin(builtinAgentBrowserEntry("/abs/agent-browser"));
  await expect(file.delete("agent-browser")).rejects.toMatchObject({ code: "mcp.builtinProtected" });
  await expect(file.save({ name: "agent-browser", command: "/x" })).rejects.toMatchObject({ code: "mcp.builtinProtected" });
});

test("setEnabled 只改 enabled", async () => {
  const { globalPath, file } = await setup();
  await file.ensureBuiltin(builtinAgentBrowserEntry("/abs/agent-browser"));
  await file.setEnabled("agent-browser", false);
  const entry = JSON.parse(await readFile(globalPath, "utf8")).mcpServers["agent-browser"];
  expect(entry.enabled).toBe(false);
  expect(entry.command).toBe("/abs/agent-browser");
});

test("全局 mcp.json 损坏时跳过物化，不抛错也不覆写", async () => {
  const { globalPath, file } = await setup();
  await writeFile(globalPath, "{ 损坏的内容");
  // 启动链 await ensureBuiltin：坏文件不能让 kernel 起不来（审查 Important #1）
  const result = await file.ensureBuiltin(builtinAgentBrowserEntry("/abs/agent-browser"));
  expect(result).toEqual({ created: false, repaired: false });
  // 坏文件原样保留：覆写会把用户自定义条目连同损坏内容一起清掉，等用户修复后下次启动自然补回
  expect(await readFile(globalPath, "utf8")).toBe("{ 损坏的内容");
});
