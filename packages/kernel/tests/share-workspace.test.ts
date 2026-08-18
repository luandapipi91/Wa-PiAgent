import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import {
  addItem,
  buildDeployZip,
  clearItems,
  loadItems,
  loadLastDeployed,
  pendingCount,
  removeItem,
  saveLastDeployed,
  totalSize,
} from "../src/share/workspace";

let dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "ws-test-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

const entry = (name: string, text: string) => ({
  name,
  data: new TextEncoder().encode(text),
});

test("addItem 写文件并记录状态，loadItems 读回", async () => {
  const d = await tmp();
  await addItem(d, "abc123", "a.html", [entry("a.html", "<h1>A</h1>")]);
  const items = await loadItems(d);
  expect(items.length).toBe(1);
  expect(items[0].id).toBe("abc123");
  expect(items[0].size).toBe(10);
  expect(await readFile(join(d, "items/abc123/a.html"), "utf8")).toBe("<h1>A</h1>");
});

test("addItem 同 id 覆盖不产生重复记录", async () => {
  const d = await tmp();
  await addItem(d, "abc123", "a.html", [entry("a.html", "v1")]);
  await addItem(d, "abc123", "a.html", [entry("a.html", "v2-longer")]);
  const items = await loadItems(d);
  expect(items.length).toBe(1);
  expect(items[0].size).toBe(9);
});

test("addItem 支持子目录条目", async () => {
  const d = await tmp();
  await addItem(d, "id1", "站点", [entry("index.html", "x"), entry("css/a.css", "y")]);
  const items = await loadItems(d);
  expect(items[0].files).toEqual(["index.html", "css/a.css"]);
  expect(await readFile(join(d, "items/id1/css/a.css"), "utf8")).toBe("y");
});

test("removeItem 删目录与记录；clearItems 清空", async () => {
  const d = await tmp();
  await addItem(d, "a", "a", [entry("a.txt", "1")]);
  await addItem(d, "b", "b", [entry("b.txt", "2")]);
  await removeItem(d, "a");
  expect((await loadItems(d)).map((i) => i.id)).toEqual(["b"]);
  await clearItems(d);
  expect(await loadItems(d)).toEqual([]);
});

test("loadItems 读时对账：手动删目录的记录被剔除", async () => {
  const d = await tmp();
  await addItem(d, "a", "a", [entry("a.txt", "1")]);
  await addItem(d, "b", "b", [entry("b.txt", "2")]);
  await rm(join(d, "items/a"), { recursive: true });
  const items = await loadItems(d);
  expect(items.map((i) => i.id)).toEqual(["b"]);
  // 对账结果已落盘
  expect((await loadItems(d)).map((i) => i.id)).toEqual(["b"]);
});

test("buildDeployZip 含 index.html 与全部条目前缀路径", async () => {
  const d = await tmp();
  await addItem(d, "id1", "a.html", [entry("a.html", "A")]);
  await addItem(d, "id2", "站点", [entry("index.html", "B"), entry("x/y.js", "C")]);
  const files = unzipSync(await buildDeployZip(d));
  expect(Object.keys(files).sort()).toEqual([
    "id1/a.html",
    "id2/index.html",
    "id2/x/y.js",
    "index.html",
  ]);
  expect(strFromU8(files["id2/x/y.js"])).toBe("C");
  expect(strFromU8(files["index.html"])).toContain("WaPi Shares");
});

test("pendingCount：与上次部署快照对比（新增/删除/变化各计 1）", async () => {
  const d = await tmp();
  await addItem(d, "a", "a", [entry("a.txt", "1")]);
  expect(await pendingCount(d)).toBe(1); // 新增 a
  await saveLastDeployed(d, await loadItems(d));
  expect(await pendingCount(d)).toBe(0);
  await addItem(d, "b", "b", [entry("b.txt", "2")]);
  await removeItem(d, "a");
  expect(await pendingCount(d)).toBe(2); // 删 a + 增 b
});

test("totalSize 汇总记录大小", async () => {
  const d = await tmp();
  await addItem(d, "a", "a", [entry("a.txt", "12345")]);
  expect(totalSize(await loadItems(d))).toBe(5);
});
