import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpTrustStore, trustKeyFor } from "../mcp-trust.ts";

async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), "trust-"));
  return d;
}

describe("McpTrustStore", () => {
  test("键必须是 realpath 结果原样（F13）", async () => {
    const dir = await tempDir();
    const nested = join(dir, "a", "b");
    await mkdir(nested, { recursive: true });
    const key = await trustKeyFor(join(dir, "a", "..", "a", "b"));
    expect(key).toBe(await trustKeyFor(nested));
    expect(key.endsWith("b")).toBe(true);
  });

  test("写入后能被自己查到，且未受信目录不被误判", async () => {
    const dir = await tempDir();
    const proj = join(dir, "proj");
    const other = join(dir, "other");
    await mkdir(proj, { recursive: true });
    await mkdir(other, { recursive: true });
    const store = new McpTrustStore(join(dir, "trust.json"));
    await store.set(proj, true);
    expect(await store.get(proj)).toBe(true);
    expect(await store.get(other)).toBe(null);
  });

  test("祖先受信可继承，子目录取最近一条决定（F13）", async () => {
    const dir = await tempDir();
    const parent = join(dir, "p");
    const child = join(parent, "c");
    await mkdir(child, { recursive: true });
    const store = new McpTrustStore(join(dir, "trust.json"));
    await store.set(parent, true);
    expect(await store.get(child)).toBe(true);
    await store.set(child, false);
    expect(await store.get(child)).toBe(false);
    expect(await store.get(parent)).toBe(true);
  });

  test("同进程并发 set() 不丢决定、不互踩临时文件（端点每次请求都新建实例）", async () => {
    const dir = await tempDir();
    const path = join(dir, "trust.json");
    const projects = ["p1", "p2", "p3", "p4"];
    for (const name of projects) await mkdir(join(dir, name), { recursive: true });
    // 等价于两次 HTTP 请求各自 new McpTrustStore(<同一个 trust.json>)：不同实例、并发写同一份文件
    await Promise.all(
      projects.map((name) => new McpTrustStore(path).set(join(dir, name), true)),
    );
    const raw = JSON.parse(await readFile(path, "utf8"));
    for (const name of projects) {
      expect(raw[await trustKeyFor(join(dir, name))]).toBe(true);
    }
  });

  test("文件不存在时写入并保持其它键", async () => {
    const dir = await tempDir();
    const path = join(dir, "trust.json");
    await writeFile(path, JSON.stringify({ [await trustKeyFor(dir)]: false }));
    const store = new McpTrustStore(path);
    const proj = join(dir, "x");
    await mkdir(proj, { recursive: true });
    await store.set(proj, true);
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(raw).length).toBe(2);
  });
});
