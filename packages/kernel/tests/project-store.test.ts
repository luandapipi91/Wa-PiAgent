import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore } from "../src/project-store";

function tempFile() {
  return join(import.meta.dir, ".tmp-projects-" + Math.random().toString(36).slice(2) + ".json");
}

test("load 空状态返回空数组", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const { projects, sessions } = await store.load();
  expect(projects).toEqual([]);
  expect(sessions).toEqual([]);
  rmSync(f, { force: true });
});

test("createProject 持久化", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createProject({ name: "项目A", cwd: "/work/a" });
  expect(p.name).toBe("项目A");
  const { projects } = await store.load();
  expect(projects).toHaveLength(1);
  rmSync(f, { force: true });
});

test("createSession 归属项目", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createProject({ name: "P", cwd: "/p" });
  const s = await store.createSession({ projectId: p.id, primaryAgent: "dev", title: "会话1" });
  expect(s.projectId).toBe(p.id);
  expect(s.primaryAgent).toBe("dev");
  const { sessions } = await store.load();
  expect(sessions).toHaveLength(1);
  rmSync(f, { force: true });
});

test("deleteProject 级联删 session", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createProject({ name: "P", cwd: "/p" });
  await store.createSession({ projectId: p.id, primaryAgent: "dev", title: "s1" });
  await store.deleteProject(p.id);
  const { projects, sessions } = await store.load();
  expect(projects).toEqual([]);
  expect(sessions).toEqual([]);
  rmSync(f, { force: true });
});

test("updateProject 改名", async () => {
  const f = tempFile();
  const store = new ProjectStore(f);
  const p = await store.createProject({ name: "旧", cwd: "/p" });
  await store.updateProject(p.id, { name: "新" });
  const { projects } = await store.load();
  expect(projects[0].name).toBe("新");
  rmSync(f, { force: true });
});
