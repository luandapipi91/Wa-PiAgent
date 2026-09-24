/**
 * `GET /api/skills` 的项目技能来源接线测试（任务 2 步骤 5）
 *
 * 契约：WSServer.scanSkillsWithExtensions 必须把 `projectStore.loadActive()` 的项目
 * 派生为技能来源（`<project.cwd>/.pi/skills`）传给 `skillManager.scan`，否则
 * `collectProjectSkillSources` 这个新纯函数在生产链路上没有调用点，项目技能永远扫不到。
 *
 * 用真实 WSServer + 真实 ProjectStore / SkillManager（不 mock 扫描与聚合），
 * 经真实 HTTP `GET /api/skills` 断言项目来源技能与 dirs。
 */
import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore } from "../src/project-store";
import { SkillManager } from "../src/skill-manager";
import { WSServer } from "../src/ws-server";

/** 临时目录（同目录下，随用随删） */
function tmp(s: string): string {
  return join(import.meta.dir, `.tmp-saps-${s}-${Math.random().toString(36).slice(2)}`);
}

/** 在 dir 下造一个含 SKILL.md 的技能 */
function createSkillAt(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
  );
}

test("GET /api/skills 返回项目技能来源（<project.cwd>/.pi/skills）", async () => {
  const baseDir = tmp("root");
  const dataDir = join(baseDir, "data"); // builtinDir = dataDir/skills
  const projectDir = join(baseDir, "proj");
  const projectSkillsDir = join(projectDir, ".pi", "skills");
  createSkillAt(join(dataDir, "skills"), "builtin-skill", "内置");
  createSkillAt(projectSkillsDir, "project-skill", "项目技能");

  const projectsFile = join(baseDir, "projects.json");
  writeFileSync(
    projectsFile,
    JSON.stringify({
      projects: [
        { id: "p1", name: "测试项目", cwd: projectDir, createdAt: Date.now() },
      ],
      sessions: [],
    }),
  );

  const server = new WSServer({
    configStore: {} as any,
    projectStore: new ProjectStore(projectsFile),
    providerStore: {} as any,
    skillManager: new SkillManager(dataDir),
    extensionManager: {
      getEnabledExtensionSkillPaths: async () => [],
    } as any,
    memoryStore: null as any,
    mcpStore: null as any,
    agentManager: {
      markSkillsDirty: () => {},
      markAllDirty: () => {},
      disposeAll: async () => {},
    } as any,
    channelManager: null,
    port: 0,
  });

  await server.start();
  try {
    const res = await fetch(`http://127.0.0.1:${server.actualPort}/api/skills`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    const projectSkill = body.skills.find((s: any) => s.name === "project-skill");
    expect(projectSkill).toBeDefined();
    expect(projectSkill.path).toBe(join(projectSkillsDir, "project-skill"));
    expect(projectSkill.source).toEqual({
      type: "project",
      projectId: "p1",
      projectName: "测试项目",
    });
    expect(body.dirs).toContainEqual({
      path: projectSkillsDir,
      type: "project",
      projectId: "p1",
      projectName: "测试项目",
    });
  } finally {
    await server.stop();
    rmSync(baseDir, { recursive: true, force: true });
  }
});
