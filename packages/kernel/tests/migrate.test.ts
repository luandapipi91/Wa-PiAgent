import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { migrateLegacySessions } from "../src/migrate";
import { ProjectStore } from "../src/project-store";

function tmp(s: string) {
  return join(import.meta.dir, s + Math.random().toString(36).slice(2));
}

test("无项目无 session 不迁移（新用户走空态）", async () => {
  const pf = tmp("pf.json");
  const ps = new ProjectStore(pf);
  expect(await migrateLegacySessions(ps)).toBe(false);
  const { projects } = await ps.load();
  expect(projects).toEqual([]);
  rmSync(pf, { force: true });
});

test("已有项目不迁移", async () => {
  const pf = tmp("pf.json");
  const ps = new ProjectStore(pf);
  await ps.createProject({ name: "已存在", cwd: "/x" });
  expect(await migrateLegacySessions(ps)).toBe(false);
  const { projects } = await ps.load();
  expect(projects).toHaveLength(1);
  expect(projects[0].name).toBe("已存在");
  rmSync(pf, { force: true });
});

test("无项目但有孤儿 session → 建默认项目并 reassign", async () => {
  const pf = tmp("pf.json");
  const ps = new ProjectStore(pf);
  // 模拟老数据：直接造一个 projectId 指向不存在项目的 session
  await ps.createSession({ projectId: "legacy-nonexistent", primaryAgent: "dev", title: "老会话" });
  const migrated = await migrateLegacySessions(ps);
  expect(migrated).toBe(true);
  const { projects, sessions } = await ps.load();
  expect(projects).toHaveLength(1);
  expect(projects[0].name).toBe("默认项目");
  // 孤儿 session 已归入默认项目
  expect(sessions).toHaveLength(1);
  expect(sessions[0].projectId).toBe(projects[0].id);
  rmSync(pf, { force: true });
});
