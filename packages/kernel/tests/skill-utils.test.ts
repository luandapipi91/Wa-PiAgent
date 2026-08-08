import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFrontmatter, scanSkillsDir, hasSkillMd } from "../src/skill-utils";

function tmpDir() {
  const dir = join(import.meta.dir, ".tmp-skill-utils-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n内容`);
}

let dir: string;
beforeEach(() => { dir = tmpDir(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("parseSkillFrontmatter 提取 name 和 description", () => {
  const info = parseSkillFrontmatter(
    "---\nname: my-skill\ndescription: 测试技能\n---\n# body",
    "/skills/my-skill",
  );
  expect(info).toEqual({ name: "my-skill", description: "测试技能", path: "/skills/my-skill" });
});

test("parseSkillFrontmatter 无 frontmatter 返回 null", () => {
  expect(parseSkillFrontmatter("just text", "/x")).toBeNull();
});

test("parseSkillFrontmatter 解析 YAML 块标量多行 description（| 与 >-）", () => {
  const pipe = parseSkillFrontmatter(
    "---\nname: ctx-index\ndescription: |\n  Index a local file or directory into the knowledge base\n  so future search can retrieve focused snippets.\nuser-invocable: true\n---\n# body",
    "/skills/ctx-index",
  );
  expect(pipe?.description).toBe(
    "Index a local file or directory into the knowledge base so future search can retrieve focused snippets.",
  );
  const folded = parseSkillFrontmatter(
    "---\nname: s2\ndescription: >-\n  第一行\n  第二行\n---\n# body",
    "/skills/s2",
  );
  expect(folded?.description).toBe("第一行 第二行");
});

test("scanSkillsDir 扫描并标记 source", async () => {
  createSkill(dir, "alpha", "技能 A");
  createSkill(dir, "beta", "技能 B");
  const result = await scanSkillsDir(dir, { type: "extension", name: "pkg-x" });
  expect(result).toHaveLength(2);
  expect(result.every(s => s.source?.type === "extension")).toBe(true);
  expect(result.every(s => s.source?.name === "pkg-x")).toBe(true);
});

test("scanSkillsDir 无 source 参数时 SkillInfo 不含 source", async () => {
  createSkill(dir, "alpha", "技能 A");
  const result = await scanSkillsDir(dir);
  expect(result[0].source).toBeUndefined();
});

test("hasSkillMd 目录含 SKILL.md 返回 found", async () => {
  createSkill(dir, "alpha", "技能 A");
  const result = await hasSkillMd(dir);
  expect(result.found).toBe(true);
});

test("hasSkillMd 空目录返回 not found", async () => {
  const result = await hasSkillMd(dir);
  expect(result.found).toBe(false);
});
