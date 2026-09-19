import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillManager } from "../src/skill-manager";
import { errorCodeOf } from "./helpers/kernel-error-code";

/** 创建临时隔离目录 */
function tmpDir() {
  const dir = join(
    import.meta.dir,
    ".tmp-skills-" + Math.random().toString(36).slice(2),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 在指定目录下创建一个技能（含 SKILL.md，格式与 Pi SDK 兼容） */
function createSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n内容`,
  );
}

let dir: string;

beforeEach(() => {
  dir = tmpDir();
  // 创建内置技能目录
  mkdirSync(join(dir, "skills"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("scan 空目录返回空技能列表", async () => {
  const mgr = new SkillManager(dir);
  const result = await mgr.scan();
  expect(result.skills).toEqual([]);
  expect(result.allSkills).toEqual([]);
  expect(result.builtinDir).toBe(join(dir, "skills"));
  expect(result.dirs).toContain(join(dir, "skills"));
});

test("scan 扫描出内置目录的技能", async () => {
  createSkill(join(dir, "skills"), "brave-search", "web 搜索");
  const mgr = new SkillManager(dir);
  const result = await mgr.scan();
  expect(result.allSkills.some((s) => s.name === "brave-search")).toBe(true);
});

test("addDir 添加用户目录后 scan 能扫到该目录技能", async () => {
  // 内置目录放一个技能
  createSkill(join(dir, "skills"), "builtin-skill", "内置技能");
  // 用户目录放一个技能
  const userDir = join(dir, "user-skills");
  mkdirSync(userDir, { recursive: true });
  createSkill(userDir, "user-skill", "用户技能");

  const mgr = new SkillManager(dir);
  await mgr.addDir(userDir);
  const result = await mgr.scan();
  expect(result.allSkills.some((s) => s.name === "user-skill")).toBe(true);
  expect(result.dirs).toContain(userDir);
});

test("addDir 路径不存在抛错", async () => {
  const mgr = new SkillManager(dir);
  expect(await errorCodeOf(mgr.addDir(join(dir, "nonexistent")))).toBe(
    "skill.dirNotFound",
  );
});

test("removeDir 内置目录抛错", async () => {
  const mgr = new SkillManager(dir);
  const builtinDir = join(dir, "skills");
  expect(await errorCodeOf(mgr.removeDir(builtinDir))).toBe(
    "skill.builtinUndeletable",
  );
});

test("addDir 拒绝明显非技能的超大目录", async () => {
  const bigDir = join(dir, "big-non-skill");
  mkdirSync(bigDir, { recursive: true });
  for (let i = 0; i < 35; i++) {
    mkdirSync(join(bigDir, `folder-${i}`), { recursive: true });
  }
  const mgr = new SkillManager(dir);
  await expect(mgr.addDir(bigDir)).rejects.toThrow();
  expect(await errorCodeOf(mgr.addDir(bigDir))).toBe("skill.noSkillMd");
});

test("removeDir 用户目录后 settings.json 移除", async () => {
  const userDir = join(dir, "user-skills");
  mkdirSync(userDir, { recursive: true });
  const mgr = new SkillManager(dir);
  await mgr.addDir(userDir);
  await mgr.removeDir(userDir);
  const result = await mgr.scan();
  expect(result.dirs).not.toContain(userDir);
});

test("toggleSkill 禁用后 skills 不含该技能但 allSkills 含", async () => {
  createSkill(join(dir, "skills"), "brave-search", "web 搜索");
  const mgr = new SkillManager(dir);
  await mgr.toggleSkill("brave-search", true);
  const result = await mgr.scan();
  expect(result.allSkills.some((s) => s.name === "brave-search")).toBe(true);
  expect(result.skills.some((s) => s.name === "brave-search")).toBe(false);
  expect(result.disabledSkills).toContain("brave-search");
});

test("toggleSkill 启用后从 disabledSkills 移除", async () => {
  createSkill(join(dir, "skills"), "brave-search", "web 搜索");
  const mgr = new SkillManager(dir);
  await mgr.toggleSkill("brave-search", true); // 先禁用
  await mgr.toggleSkill("brave-search", false); // 再启用
  const result = await mgr.scan();
  expect(result.disabledSkills).not.toContain("brave-search");
  expect(result.skills.some((s) => s.name === "brave-search")).toBe(true);
});

test("去重：内置目录同名技能优先于用户目录", async () => {
  // 内置和用户目录都放同名技能，描述不同
  createSkill(join(dir, "skills"), "dup-skill", "内置版本");
  const userDir = join(dir, "user-skills");
  mkdirSync(userDir, { recursive: true });
  createSkill(userDir, "dup-skill", "用户版本");

  const mgr = new SkillManager(dir);
  await mgr.addDir(userDir);
  const result = await mgr.scan();
  const dup = result.allSkills.find((s) => s.name === "dup-skill");
  expect(dup).toBeTruthy();
  expect(dup!.description).toBe("内置版本"); // 内置优先
});

test("scan 返回的 SkillInfo 含 skill 目录绝对路径", async () => {
  createSkill(join(dir, "skills"), "brave-search", "web 搜索");
  const userDir = join(dir, "user-skills");
  mkdirSync(userDir, { recursive: true });
  createSkill(userDir, "user-skill", "用户技能");

  const mgr = new SkillManager(dir);
  await mgr.addDir(userDir);
  const result = await mgr.scan();
  const builtin = result.allSkills.find((s) => s.name === "brave-search");
  const user = result.allSkills.find((s) => s.name === "user-skill");
  expect(builtin?.path).toBe(join(join(dir, "skills"), "brave-search"));
  expect(user?.path).toBe(join(userDir, "user-skill"));
});
