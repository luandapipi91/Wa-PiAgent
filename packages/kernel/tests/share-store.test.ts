import { test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { loadShares, appendShare, removeShare } from "../src/share-store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "share-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("appendShare 后 loadShares 返回记录", async () => {
  const file = join(dir, "share-history.json");
  const rec = {
    id: "s1",
    url: "https://a.edgeone.cool?eo_token=x",
    projectName: "share-abc",
    channel: "edgeone",
    createdAt: 1,
    expiresAt: 1000,
    paths: ["/p/a.html"],
  };
  await appendShare(file, rec);
  expect(await loadShares(file)).toEqual([rec]);
});

test("removeShare 删除指定 id", async () => {
  const file = join(dir, "share-history.json");
  await appendShare(file, {
    id: "s1",
    url: "u1",
    projectName: "p",
    channel: "edgeone",
    createdAt: 1,
    expiresAt: 2,
    paths: [],
  });
  await appendShare(file, {
    id: "s2",
    url: "u2",
    projectName: "p",
    channel: "edgeone",
    createdAt: 1,
    expiresAt: 2,
    paths: [],
  });
  await removeShare(file, "s1");
  const shares = await loadShares(file);
  expect(shares.map((s) => s.id)).toEqual(["s2"]);
});

test("文件不存在时 loadShares 返回空数组", async () => {
  expect(await loadShares(join(dir, "missing.json"))).toEqual([]);
});
