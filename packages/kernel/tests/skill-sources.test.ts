import { test, expect } from "bun:test";
import { projectSkillsDirOf, collectProjectSkillSources } from "../src/skill-sources";

test("projectSkillsDirOf 拼出 <cwd>/.pi/skills，cwd 为空返回 undefined", () => {
  expect(projectSkillsDirOf("/Users/co/work/proj")).toBe("/Users/co/work/proj/.pi/skills");
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
  expect(out.map((p) => p.dir)).toEqual(["/a/.pi/skills", "/b/.pi/skills"]);
});
