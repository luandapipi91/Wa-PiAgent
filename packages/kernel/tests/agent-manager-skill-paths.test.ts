import { test, expect } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillManager } from "../src/skill-manager";

function tmpDir() {
  const dir = join(import.meta.dir, ".tmp-agent-skills-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}`,
  );
}

// 直接测试 resolveEnabledSkillPaths 的核心逻辑：
// skillManager.scan({ projects, extensionSkillPaths }) 返回的 skills 中，
// 来自项目目录和扩展包目录的技能路径都应该被收集。
test("scan 含扩展技能时，扩展来源技能出现在 allSkills 中", async () => {
  const dataDir = tmpDir();
  mkdirSync(join(dataDir, "skills"), { recursive: true });

  // 模拟扩展技能目录
  const extDir = join(dataDir, "fake-ext", "skills");
  createSkill(extDir, "ext-skill", "扩展技能");
  // 注意：实际扩展技能在 ~/.wa-pi/runtime/node_modules/<pkg>/skills，
  // 这里用任意路径模拟

  const mgr = new SkillManager(dataDir);
  const result = await mgr.scan({
    extensionSkillPaths: [
      { path: join(dataDir, "fake-ext", "skills"), packageName: "fake-ext" },
    ],
  });

  const extSkill = result.allSkills.find((s) => s.name === "ext-skill");
  expect(extSkill).toBeDefined();
  expect(extSkill?.source?.type).toBe("extension");
  expect(extSkill?.source?.name).toBe("fake-ext");

  rmSync(dataDir, { recursive: true, force: true });
});

test("项目技能目录参与扫描，且同名时项目版本生效（--skill 顺序项目在前）", async () => {
  const dataDir = tmpDir();
  mkdirSync(join(dataDir, "skills"), { recursive: true });
  createSkill(join(dataDir, "skills"), "dup-skill", "内置同名");

  const projSkills = join(dataDir, "proj", ".pi", "skills");
  createSkill(projSkills, "dup-skill", "项目同名");
  createSkill(projSkills, "proj-only", "项目独有");

  const mgr = new SkillManager(dataDir);
  const result = await mgr.scan({
    projects: [{ id: "p1", name: "项目一", dir: projSkills }],
  });

  // 目录顺序：项目目录在最前（决定 --skill 顺序）
  expect(result.dirs[0]).toMatchObject({ path: projSkills, type: "project" });
  // 同名取项目版本
  const dup = result.skills.find((s) => s.name === "dup-skill");
  expect(dup?.description).toBe("项目同名");
  expect(dup?.path.startsWith(projSkills)).toBe(true);
  // 项目独有技能也在生效列表
  expect(result.skills.map((s) => s.name)).toContain("proj-only");

  rmSync(dataDir, { recursive: true, force: true });
});
