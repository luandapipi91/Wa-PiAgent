import { test, expect } from "bun:test";
import { join } from "node:path";
import { projectSkillsDirOf, collectProjectSkillSources } from "../src/skill-sources";

test("projectSkillsDirOf 拼出 <cwd>/.pi/skills，cwd 为空返回 undefined", () => {
  // <cwd>/.pi/skills：用 join 构造期望，避免把本机分隔符（Windows 为反斜杠）写死
  expect(projectSkillsDirOf("/Users/co/work/proj")).toBe(
    join("/Users/co/work/proj", ".pi", "skills"),
  );
  expect(projectSkillsDirOf("")).toBeUndefined();
  expect(projectSkillsDirOf(undefined)).toBeUndefined();
});

test("collectProjectSkillSources 过滤空 cwd 并保持项目顺序", () => {
  const out = collectProjectSkillSources([
    { id: "p1", name: "Wa-Pi", cwd: "/a" },
    { id: "p2", name: "空项目", cwd: "" },
    { id: "p3", name: "hik", cwd: "/b" },
  ]);
  expect(out.map((p) => p.id)).toEqual(["p1", "p3"]);
  expect(out.map((p) => p.dir)).toEqual([
    join("/a", ".pi", "skills"),
    join("/b", ".pi", "skills"),
  ]);
});
