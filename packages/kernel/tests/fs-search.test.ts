import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchFiles } from "../src/ws-server";

function makeTempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("searchFiles", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir("wa-pi-search-");
    // 构建一个较深的目录结构，其中包含名为 skills 的文件夹
    mkdirSync(join(root, "src", "components", "skills"), { recursive: true });
    mkdirSync(join(root, "packages", "kernel", "skills"), { recursive: true });
    mkdirSync(join(root, "docs", "guides"), { recursive: true });
    writeFileSync(join(root, "src", "components", "skills", "react.md"), "react skill");
    writeFileSync(join(root, "packages", "kernel", "skills", "node.md"), "node skill");
    writeFileSync(join(root, "docs", "guides", "intro.md"), "intro");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("能递归搜索到名为 skills 的文件夹", async () => {
    const start = Date.now();
    const { matches, truncated } = await searchFiles(root, "skills", false, 100, 12);
    const duration = Date.now() - start;

    expect(truncated).toBe(false);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.some(m => m.name === "skills" && m.isDir)).toBe(true);
    expect(matches.some(m => m.path === join(root, "src", "components", "skills"))).toBe(true);
    expect(matches.some(m => m.path === join(root, "packages", "kernel", "skills"))).toBe(true);

    console.log(`[perf] searchFiles('skills') found ${matches.length} matches in ${duration}ms`);
  });

  it("未匹配时返回空数组", async () => {
    const { matches } = await searchFiles(root, "nonexistent-xyz", false, 100, 12);
    expect(matches).toEqual([]);
  });

  it("受 maxResults 限制时会截断", async () => {
    // 创建大量名为 skill-0 ... skill-9 的文件
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(root, `skill-${i}.txt`), "x");
    }
    const { matches, truncated } = await searchFiles(root, "skill", false, 5, 12);
    expect(matches.length).toBe(5);
    expect(truncated).toBe(true);
  });
});
