// mcp-file.test.ts — McpFile.list 的曝光档归一化（pi 1.2.0 alias 合并，先红后绿）。
//
// McpFile 是盘上配置的唯一写入者、list() 是读给前端表单的唯一入口：
// 存量 mcp.json 里可能还躺着旧档 codemode-deferred（pi 1.2.0 已把它降级为 alias），
// 若读出不归一化，前端四档下拉拿到旧值会渲染成空白档。
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { McpFile } from "../src/mcp-file.ts";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try {
      rmSyncDir(dir);
    } catch {
      /* 尽力清理 */
    }
  }
});

function rmSyncDir(dir: string) {
  // Bun 无 rmSync 兼容问题：node:fs 的 rmSync 递归删除
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("node:fs").rmSync(dir, { recursive: true, force: true });
}

async function makeAdmin() {
  const dir = await mkdtemp(join(tmpdir(), "mcp-file-norm-"));
  cleanups.push(dir);
  const file = new McpFile({
    globalPath: join(dir, "mcp.json"),
    projectPathFor: async () => join(dir, "never-project", ".pi", "mcp.json"),
  });
  return { file, globalPath: join(dir, "mcp.json") };
}

describe("McpFile.list 曝光档归一化（pi 1.2.0 alias）", () => {
  test("存量配置的 exposure 与 toolExposure 旧档 codemode-deferred 归一化为 codemode", async () => {
    const { file, globalPath } = await makeAdmin();
    await writeFile(
      globalPath,
      JSON.stringify({
        mcpServers: {
          legacy: {
            command: "npx",
            args: ["-y", "some-mcp"],
            exposure: "codemode-deferred",
            toolExposure: { t1: "direct", t2: "codemode-deferred" },
          },
          fresh: {
            url: "https://example.com/mcp",
            exposure: "direct",
          },
        },
      }),
      "utf8",
    );
    const servers = await file.list();
    const legacy = servers.find((s) => s.name === "legacy");
    expect(legacy?.exposure).toBe("codemode");
    expect(legacy?.toolExposure).toEqual({ t1: "direct", t2: "codemode" });
    // 现行四档不受影响
    const fresh = servers.find((s) => s.name === "fresh");
    expect(fresh?.exposure).toBe("direct");
  });
});

// Windows PowerShell 5.1 重写 JSON 时会写入 UTF-8 BOM；pi 1.4.0 起 pi 侧已兼容，
// 而 Wa-Pi 自己的解析链若仍是裸 JSON.parse，同一份 mcp.json 会出现「引擎可读、界面报错」。
describe("mcp.json UTF-8 BOM 兼容（Windows PowerShell 5.1 写盘）", () => {
  test("readPath 能解析开头带 BOM 的配置", async () => {
    const { file, globalPath } = await makeAdmin();
    await writeFile(
      globalPath,
      "\uFEFF" + JSON.stringify({ mcpServers: { a: { command: "npx" } } }),
      "utf8",
    );
    const raw = await file.readPath(globalPath);
    expect(Object.keys(raw.mcpServers)).toEqual(["a"]);
  });
});
