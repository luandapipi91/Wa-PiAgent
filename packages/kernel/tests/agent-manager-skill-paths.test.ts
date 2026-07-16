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
// skillManager.scan(extPaths) 返回的 skills 中，
// 来自 userDirs 和 extensionPaths 的技能路径都应该被收集。
test("scan 含扩展技能时，扩展来源技能出现在 allSkills 中", async () => {
  const dataDir = tmpDir();
  mkdirSync(join(dataDir, "skills"), { recursive: true });

  // 模拟扩展技能目录
  const extDir = join(dataDir, "fake-ext", "skills");
  createSkill(extDir, "ext-skill", "扩展技能");
  // 注意：实际扩展技能在 ~/.hiagent/runtime/node_modules/<pkg>/skills，
  // 这里用任意路径模拟

  const mgr = new SkillManager(dataDir);
  const result = await mgr.scan([
    { path: join(dataDir, "fake-ext", "skills"), packageName: "fake-ext" },
  ]);

  const extSkill = result.allSkills.find((s) => s.name === "ext-skill");
  expect(extSkill).toBeDefined();
  expect(extSkill?.source?.type).toBe("extension");
  expect(extSkill?.source?.name).toBe("fake-ext");

  rmSync(dataDir, { recursive: true, force: true });
});
