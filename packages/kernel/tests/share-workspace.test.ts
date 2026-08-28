import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import {
  addItem,
  buildDeployZip,
  clearItems,
  loadItems,
  pendingCount,
  removeItem,
  renameItem,
  saveLastDeployed,
  totalSize,
} from "../src/share/workspace";
import { errorCodeOf } from "./helpers/kernel-error-code";

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
  await addItem(d, "abc123abc123", "a.html", [entry("a.html", "<h1>A</h1>")]);
  const items = await loadItems(d);
  expect(items.length).toBe(1);
  expect(items[0].id).toBe("abc123abc123");
  expect(items[0].size).toBe(10);
  expect(await readFile(join(d, "items/a.html/a.html"), "utf8")).toBe(
    "<h1>A</h1>",
  );
});

test("addItem 同 id 覆盖不产生重复记录", async () => {
  const d = await tmp();
  await addItem(d, "abc123abc123", "a.html", [entry("a.html", "v1")]);
  await addItem(d, "abc123abc123", "a.html", [entry("a.html", "v2-longer")]);
  const items = await loadItems(d);
  expect(items.length).toBe(1);
  expect(items[0].size).toBe(9);
});

test("addItem 合并：旧目录中已被删除的文件不进并集（files 只保留磁盘存在的）", async () => {
  const d = await tmp();
  await addItem(d, "aaaaaaaaaaaa", "site", [
    entry("index.html", "old"),
    entry("keep.js", "K"),
  ]);
  // 模拟用户改动分享目录：删除 index.html（磁盘上不存在了）
  await rm(join(d, "items/site/index.html"));
  // 再次同名分享（不同内容）→ 合并
  await addItem(d, "bbbbbbbbbbbb", "site", [entry("new.js", "N")]);
  const items = await loadItems(d);
  expect(items.length).toBe(1);
  // 旧 files 里磁盘已不存在的 index.html 被剔除，只保留 keep.js + new.js
  expect(items[0].files.sort()).toEqual(["keep.js", "new.js"]);
});

test("addItem 不同 id 同名 → 合并为一条：旧文件保留、新文件追加、同路径新覆盖旧", async () => {
  const d = await tmp();
  // 第一次分享：id1 名 site，含 index.html + old.js
  await addItem(d, "aaaaaaaaaaaa", "site", [
    entry("index.html", "<h1>old</h1>"),
    entry("old.js", "var a = 1;"),
  ]);
  // 第二次分享：id2 名 site（不同内容 → 不同 id），含 index.html（同路径新内容）+ new.js
  await addItem(d, "bbbbbbbbbbbb", "site", [
    entry("index.html", "<h1>new</h1>"),
    entry("new.js", "var b = 2;"),
  ]);
  const items = await loadItems(d);
  // 合并为一条记录，id 为本次（新）id
  expect(items.length).toBe(1);
  expect(items[0].id).toBe("bbbbbbbbbbbb");
  expect(items[0].name).toBe("site");
  // files 为并集（去重）
  expect(items[0].files.sort()).toEqual(["index.html", "new.js", "old.js"]);
  // 旧文件保留 + 新文件写入 + 同路径 index.html 被新内容覆盖
  expect(await readFile(join(d, "items/site/index.html"), "utf8")).toBe(
    "<h1>new</h1>",
  );
  expect(await readFile(join(d, "items/site/old.js"), "utf8")).toBe(
    "var a = 1;",
  );
  expect(await readFile(join(d, "items/site/new.js"), "utf8")).toBe(
    "var b = 2;",
  );
  // size 为合并后目录总字节数（<h1>new</h1>=12 + old.js=10 + new.js=10 = 32）
  expect(items[0].size).toBe(32);
});

test("addItem 支持子目录条目", async () => {
  const d = await tmp();
  await addItem(d, "a1b2c3d4e5f6", "站点", [
    entry("index.html", "x"),
    entry("css/a.css", "y"),
  ]);
  const items = await loadItems(d);
  expect(items[0].files).toEqual(["index.html", "css/a.css"]);
  expect(await readFile(join(d, "items/站点/css/a.css"), "utf8")).toBe("y");
});

test("removeItem 删目录与记录；clearItems 清空", async () => {
  const d = await tmp();
  await addItem(d, "aaaaaaaaaaaa", "a", [entry("a.txt", "1")]);
  await addItem(d, "bbbbbbbbbbbb", "b", [entry("b.txt", "2")]);
  expect(await removeItem(d, "aaaaaaaaaaaa")).toBe(true);
  expect((await loadItems(d)).map((i) => i.id)).toEqual(["bbbbbbbbbbbb"]);
  await clearItems(d);
  expect(await loadItems(d)).toEqual([]);
});

test("removeItem 非法 id（路径穿越）→ 返回 false 且不删任何文件", async () => {
  const d = await tmp();
  await addItem(d, "aaaaaaaaaaaa", "a", [entry("a.txt", "1")]);
  const sentinel = join(d, "sentinel.txt");
  await writeFile(sentinel, "keep", "utf8");
  // "../.." 会解析到 items/ 的祖父目录，校验必须拦下
  expect(await removeItem(d, "../..")).toBe(false);
  expect(await readFile(sentinel, "utf8")).toBe("keep");
  expect((await loadItems(d)).map((i) => i.id)).toEqual(["aaaaaaaaaaaa"]);
});

test("loadItems 读时对账：手动删目录的记录被剔除", async () => {
  const d = await tmp();
  await addItem(d, "aaaaaaaaaaaa", "a", [entry("a.txt", "1")]);
  await addItem(d, "bbbbbbbbbbbb", "b", [entry("b.txt", "2")]);
  await rm(join(d, "items/a"), { recursive: true });
  const items = await loadItems(d);
  expect(items.map((i) => i.id)).toEqual(["bbbbbbbbbbbb"]);
  // 对账结果已落盘
  expect((await loadItems(d)).map((i) => i.id)).toEqual(["bbbbbbbbbbbb"]);
});

test("loadItems 对账剔除非法 id 记录并落盘", async () => {
  const d = await tmp();
  await addItem(d, "aaaaaaaaaaaa", "a", [entry("a.txt", "1")]);
  // 手动往 state.json 塞一条非法 id 记录（"../.." 解析到存在的目录，无校验会漏网）
  const statePath = join(d, "state.json");
  const raw = JSON.parse(await readFile(statePath, "utf8"));
  raw.items.push({ id: "../..", name: "x", files: [], size: 0, createdAt: 0 });
  await writeFile(statePath, JSON.stringify(raw), "utf8");
  expect((await loadItems(d)).map((i) => i.id)).toEqual(["aaaaaaaaaaaa"]);
  // 剔除结果已落盘
  const after = JSON.parse(await readFile(statePath, "utf8"));
  expect(after.items.map((i: { id: string }) => i.id)).toEqual([
    "aaaaaaaaaaaa",
  ]);
});

test("buildDeployZip 含 index.html 与全部条目前缀路径（文件夹名 = 分享名）", async () => {
  const d = await tmp();
  await addItem(d, "a1b2c3d4e5f6", "a.html", [entry("a.html", "A")]);
  await addItem(d, "f6e5d4c3b2a1", "站点", [
    entry("index.html", "B"),
    entry("x/y.js", "C"),
  ]);
  const files = unzipSync(await buildDeployZip(d));
  expect(Object.keys(files).sort()).toEqual([
    "a.html/a.html",
    // 无用户 index.html 的目录自动生成索引页（目录 URL 可访问）
    "a.html/index.html",
    "index.html",
    "站点/index.html",
    "站点/x/y.js",
  ]);
  expect(strFromU8(files["站点/x/y.js"])).toBe("C");
  const indexHtml = strFromU8(files["index.html"]);
  expect(indexHtml).toContain("WaPi Shares");
  // 根索引页去列表化：只渲染静态说明，不公开分享清单
  expect(indexHtml).not.toContain("<ul>");
});

test("buildDeployZip：分享目录无 index.html 时生成目录索引页（文件列表 + token 透传）", async () => {
  const d = await tmp();
  // 合并后的分享：目录含 a.html + b.html（无用户 index.html）
  await addItem(d, "a1b2c3d4e5f6", "慧来客", [
    entry("a.html", "A"),
    entry("sub/b.js", "B"),
  ]);
  const files = unzipSync(await buildDeployZip(d));
  // 自动生成目录索引页（用户文件无 index.html 时）
  expect(files["慧来客/index.html"]).toBeTruthy();
  const page = strFromU8(files["慧来客/index.html"]);
  // 含文件列表：相对链接（不带 token，运行时脚本补 query）
  expect(page).toContain('href="a.html"');
  expect(page).toContain('href="sub/b.js"');
  // 含 token 透传脚本：从 location.search 读 query 拼到链接，避免 EdgeOne 子链接 401
  expect(page).toContain("location.search");
  expect(page).toContain(".file-link");
});

test("buildDeployZip：用户分享的文件本身是 index.html 时，不生成索引页覆盖用户文件", async () => {
  const d = await tmp();
  await addItem(d, "a1b2c3d4e5f6", "站点", [entry("index.html", "USER")]);
  const files = unzipSync(await buildDeployZip(d));
  // 用户文件 index.html 原样保留，不被索引页覆盖
  expect(strFromU8(files["站点/index.html"])).toBe("USER");
});

test("buildDeployZip：state 引用的文件在磁盘缺失时跳过，不崩溃（ENOENT 容错）", async () => {
  const d = await tmp();
  // 先正常写入两个文件，再手动删除一个（模拟 state 与磁盘不一致）
  await addItem(d, "a1b2c3d4e5f6", "站点", [
    entry("index.html", "OLD"),
    entry("a.js", "A"),
  ]);
  await rm(join(d, "items/站点/index.html"));
  // 不崩溃；缺失的 index.html 不进部署包，存活的 a.js 正常打包
  const files = unzipSync(await buildDeployZip(d));
  expect(strFromU8(files["站点/a.js"])).toBe("A");
  expect(files["站点/index.html"]).toBeUndefined();
});

test("pendingCount：与上次部署快照对比（新增/删除/变化各计 1）", async () => {
  const d = await tmp();
  await addItem(d, "aaaaaaaaaaaa", "a", [entry("a.txt", "1")]);
  expect(await pendingCount(d)).toBe(1); // 新增 a
  await saveLastDeployed(d, await loadItems(d));
  expect(await pendingCount(d)).toBe(0);
  await addItem(d, "bbbbbbbbbbbb", "b", [entry("b.txt", "2")]);
  await removeItem(d, "aaaaaaaaaaaa");
  expect(await pendingCount(d)).toBe(2); // 删 a + 增 b
});

test("totalSize 汇总记录大小", async () => {
  const d = await tmp();
  await addItem(d, "aaaaaaaaaaaa", "a", [entry("a.txt", "12345")]);
  expect(totalSize(await loadItems(d))).toBe(5);
});

test("loadItems 旧格式迁移：state 记录指向 items/<id>/（穿透改造前）→ 自动迁移为 items/<name>/", async () => {
  const d = await tmp();
  const itemsDirPath = join(d, "items");
  // 模拟旧格式：文件夹 = items/<id>/（穿透改造前），state 记录 name 是展示名
  await mkdir(join(itemsDirPath, "abc123abc123"), { recursive: true });
  await writeFile(
    join(itemsDirPath, "abc123abc123", "index.html"),
    "A",
    "utf8",
  );
  await writeFile(
    join(d, "state.json"),
    JSON.stringify({
      items: [
        {
          id: "abc123abc123",
          name: "旧名",
          files: ["index.html"],
          size: 1,
          createdAt: 100,
        },
      ],
    }),
    "utf8",
  );
  const items = await loadItems(d);
  // 记录保留，name 由内容推断（单文件 → index.html），文件夹已迁移
  expect(items).toHaveLength(1);
  expect(items[0].id).toBe("abc123abc123");
  expect(items[0].name).toBe("index.html");
  expect(
    await readFile(join(itemsDirPath, "index.html", "index.html"), "utf8"),
  ).toBe("A");
  // 迁移已落盘
  const saved = JSON.parse(await readFile(join(d, "state.json"), "utf8"));
  expect(saved.items[0].name).toBe("index.html");
});

test("loadItems 孤儿恢复：state 已空但 items/<id>/ 还在（旧分享）→ 扫描恢复为记录", async () => {
  const d = await tmp();
  const itemsDirPath = join(d, "items");
  // state 空 + 两个旧格式 id 文件夹
  await writeFile(join(d, "state.json"), JSON.stringify({ items: [] }), "utf8");
  await mkdir(join(itemsDirPath, "aaaaaaaaaaaa"), { recursive: true });
  await writeFile(join(itemsDirPath, "aaaaaaaaaaaa", "a.txt"), "1", "utf8");
  await mkdir(join(itemsDirPath, "bbbbbbbbbbbb", "sub"), { recursive: true });
  await writeFile(
    join(itemsDirPath, "bbbbbbbbbbbb", "sub", "b.js"),
    "2",
    "utf8",
  );
  const items = await loadItems(d);
  expect(items.map((i) => i.id).sort()).toEqual([
    "aaaaaaaaaaaa",
    "bbbbbbbbbbbb",
  ]);
  expect(items.find((i) => i.id === "aaaaaaaaaaaa")?.name).toBe("a.txt");
  // bbbbbbbbbb 只有一个文件（sub/b.js）→ 单文件取文件名 b.js
  expect(items.find((i) => i.id === "bbbbbbbbbbbb")?.name).toBe("b.js");
  // 文件夹已迁移为新格式
  expect(await readFile(join(itemsDirPath, "a.txt", "a.txt"), "utf8")).toBe(
    "1",
  );
});

test("renameItem 重命名：文件夹原子改名、文件保留、state 更新", async () => {
  const d = await tmp();
  await addItem(d, "abc123abc123", "旧名", [
    entry("a.txt", "1"),
    entry("sub/b.txt", "2"),
  ]);
  const renamed = await renameItem(d, "abc123abc123", "新名");
  expect(renamed.name).toBe("新名");
  // 文件保留在新文件夹（旧文件夹已移走）
  expect(await readFile(join(d, "items/新名/a.txt"), "utf8")).toBe("1");
  expect(await readFile(join(d, "items/新名/sub/b.txt"), "utf8")).toBe("2");
  // 旧文件夹不存在
  expect(existsSync(join(d, "items/旧名"))).toBe(false);
  // state 更新
  const items = await loadItems(d);
  expect(items[0].name).toBe("新名");
});

test("renameItem 重名 → 合并：目标记录保留 id，源目录文件合并进目标目录，仅一条记录", async () => {
  const d = await tmp();
  await addItem(d, "aaaaaaaaaaaa", "甲", [entry("a.txt", "1")]);
  await addItem(d, "bbbbbbbbbbbb", "乙", [entry("b.txt", "2")]);
  // 把「甲」重命名为「乙」（已存在）→ 合并到乙
  const renamed = await renameItem(d, "aaaaaaaaaaaa", "乙");
  expect(renamed.name).toBe("乙");
  const items = await loadItems(d);
  // 只剩一条记录，id 保留目标（乙）的 id
  expect(items.length).toBe(1);
  expect(items[0].id).toBe("bbbbbbbbbbbb");
  expect(items[0].name).toBe("乙");
  expect(items[0].files.sort()).toEqual(["a.txt", "b.txt"]);
  // 两个文件都在目标目录，源目录已删
  expect(await readFile(join(d, "items/乙/a.txt"), "utf8")).toBe("1");
  expect(await readFile(join(d, "items/乙/b.txt"), "utf8")).toBe("2");
  expect(existsSync(join(d, "items/甲"))).toBe(false);
});

test("addItem 非法分享名 → KernelError share.invalidName", async () => {
  const d = await tmp();
  expect(
    await errorCodeOf(addItem(d, "abc123abc123", "非 法!", [entry("a.txt", "1")])),
  ).toBe("share.invalidName");
});

test("renameItem 不存在的 id → KernelError share.notFound", async () => {
  const d = await tmp();
  expect(await errorCodeOf(renameItem(d, "no-such-id", "新名"))).toBe(
    "share.notFound",
  );
});

test("pendingCount：重命名后计为未部署变更（签名含 name）", async () => {
  const d = await tmp();
  await addItem(d, "abc123abc123", "旧名", [entry("a.txt", "1")]);
  await saveLastDeployed(d, await loadItems(d));
  expect(await pendingCount(d)).toBe(0);
  // 重命名 → 内容未变但名称变了 → 线上需重新部署才能生效
  await renameItem(d, "abc123abc123", "新名");
  expect(await pendingCount(d)).toBe(1);
});
