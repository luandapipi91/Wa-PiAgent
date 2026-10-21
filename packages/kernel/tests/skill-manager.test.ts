import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SkillManager } from "../src/skill-manager";

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
  expect(result.dirs).toContainEqual({ path: join(dir, "skills"), type: "builtin" });
});

test("scan 扫描出内置目录的技能", async () => {
  createSkill(join(dir, "skills"), "brave-search", "web 搜索");
  const mgr = new SkillManager(dir);
  const result = await mgr.scan();
  expect(result.allSkills.some((s) => s.name === "brave-search")).toBe(true);
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

test("同名技能项目优先，内置被标记 shadowed", async () => {
  const projectCwd = join(dir, "proj-a");
  const projSkills = join(projectCwd, ".pi", "skills");
  mkdirSync(projSkills, { recursive: true });
  createSkill(projSkills, "dup-skill", "项目版本");
  createSkill(join(dir, "skills"), "dup-skill", "内置版本");

  const mgr = new SkillManager(dir);
  const result = await mgr.scan({
    projects: [{ id: "p1", name: "项目A", dir: projSkills }],
  });

  const active = result.skills.find((s) => s.name === "dup-skill");
  expect(active?.description).toBe("项目版本");
  expect(active?.source?.type).toBe("project");
  expect(active?.source?.projectId).toBe("p1");
  expect(active?.source?.projectName).toBe("项目A");
  expect(active?.shadowed).toBeFalsy();

  const shadowedBuiltin = result.allSkills.find(
    (s) => s.name === "dup-skill" && s.source?.type === "builtin",
  );
  expect(shadowedBuiltin?.shadowed).toBe(true);
  expect(result.skills.some((s) => s.source?.type === "builtin")).toBe(false);

  // 守护：项目技能同名同样受全局 disabledSkills 约束（禁用后生效列表不含该名，
  // 但 allSkills 仍保留两条：项目版本 + 被遮蔽的内置版本）
  await mgr.toggleSkill("dup-skill", true);
  const afterDisable = await mgr.scan({
    projects: [{ id: "p1", name: "项目A", dir: projSkills }],
  });
  expect(afterDisable.skills.some((s) => s.name === "dup-skill")).toBe(false);
  expect(
    afterDisable.allSkills.filter((s) => s.name === "dup-skill"),
  ).toHaveLength(2);
});

test("scan 顺序为 项目 → 内置 → 扩展，dirs 带范围信息", async () => {
  const projSkills = join(dir, "proj-b", ".pi", "skills");
  mkdirSync(projSkills, { recursive: true });
  createSkill(projSkills, "s-project", "项目技能");
  createSkill(join(dir, "skills"), "s-builtin", "内置技能");
  const extDir = join(dir, "fake-ext", "skills");
  createSkill(extDir, "s-ext", "扩展技能");

  const mgr = new SkillManager(dir);
  const result = await mgr.scan({
    projects: [{ id: "p2", name: "项目B", dir: projSkills }],
    extensionSkillPaths: [{ path: extDir, packageName: "fake-ext" }],
  });

  expect(result.allSkills.map((s) => s.name)).toEqual([
    "s-project",
    "s-builtin",
    "s-ext",
  ]);
  expect(result.dirs.map((d) => d.type)).toEqual(["project", "builtin", "extension"]);
  expect(result.dirs[0]).toMatchObject({
    path: projSkills,
    projectId: "p2",
    projectName: "项目B",
  });
  expect(result.dirs[2]).toMatchObject({ path: extDir, name: "fake-ext" });
});

test("settings.json 的 userSkillDirs 不再生效（遗留字段被忽略）", async () => {
  const legacyDir = join(dir, "legacy-user-skills");
  mkdirSync(legacyDir, { recursive: true });
  createSkill(legacyDir, "legacy-skill", "旧用户目录技能");
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ userSkillDirs: [legacyDir], disabledSkills: [] }),
  );

  const mgr = new SkillManager(dir);
  const result = await mgr.scan();

  expect(result.allSkills.some((s) => s.name === "legacy-skill")).toBe(false);
  expect(result.dirs.some((d) => d.path === legacyDir)).toBe(false);
});

test("toggleSkill 写盘后保留历史 userSkillDirs 旧值（兼容承诺）", async () => {
  const legacyDir = join(dir, "legacy-user-skills");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ userSkillDirs: [legacyDir], disabledSkills: [] }),
  );

  const mgr = new SkillManager(dir);
  await mgr.toggleSkill("brave-search", true);

  // 写盘只更新 disabledSkills，文件中已有的旧字段原样保留（不做迁移、不主动删除）
  const written = JSON.parse(
    readFileSync(join(dir, "settings.json"), "utf8"),
  );
  expect(written.userSkillDirs).toEqual([legacyDir]);
  expect(written.disabledSkills).toEqual(["brave-search"]);
});

test("扩展来源技能仍带包名，且不因项目来源改变", async () => {
  const extDir = join(dir, "fake-ext2", "skills");
  createSkill(extDir, "ext-only", "扩展技能");
  const mgr = new SkillManager(dir);
  const result = await mgr.scan({
    extensionSkillPaths: [{ path: extDir, packageName: "fake-ext2" }],
  });
  const extSkill = result.allSkills.find((s) => s.name === "ext-only");
  expect(extSkill?.source?.type).toBe("extension");
  expect(extSkill?.source?.name).toBe("fake-ext2");
});
