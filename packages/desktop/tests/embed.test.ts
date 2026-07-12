import { test, expect } from "bun:test";
import { writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractAssets, type Asset } from "../src/embed";

test("extractAssets: 把 src 文件复制到 cacheDir/<dest>", async () => {
  const src = `${import.meta.dir}/.src.txt`;
  await writeFile(src, "payload");
  const cache = `${import.meta.dir}/.cache`;
  try {
    const assets: Asset[] = [{ src, dest: "web/index.html" }];
    const returned = await extractAssets(assets, cache);
    expect(returned).toBe(cache);
    expect(await readFile(join(cache, "web/index.html"), "utf8")).toBe(
      "payload",
    );
  } finally {
    await rm(src, { force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

test("extractAssets: 已存在的 dest 跳过（不重写）", async () => {
  const src = `${import.meta.dir}/.src2.txt`;
  const cache = `${import.meta.dir}/.cache2`;
  await writeFile(src, "new");
  // 预先写入一个旧版本，验证不会被覆盖
  await rm(cache, { recursive: true, force: true });
  const destPath = join(cache, "out.txt");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(cache), { recursive: true });
  await writeFile(destPath, "old");
  try {
    await extractAssets([{ src, dest: "out.txt" }], cache);
    expect(await readFile(destPath, "utf8")).toBe("old");
  } finally {
    await rm(src, { force: true });
    await rm(cache, { recursive: true, force: true });
  }
});
