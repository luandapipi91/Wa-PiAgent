import { test, expect } from "bun:test";
import { projectSkillsDirOf, collectProjectSkillSources } from "../src/skill-sources";

// 分隔符归一：path.join 在 Windows 产出 `\`、macOS/Linux 产出 `/`。
// 断言统一按 `/` 比较，避免同一份实现在不同平台上一个过一个挂。
const norm = (p: string) => p.replace(/\\/g, "/");

test("projectSkillsDirOf 拼出 <cwd>/.pi/skills，cwd 为空返回 undefined", () => {
  expect(norm(projectSkillsDirOf("/Users/co/work/proj")!)).toBe("/Users/co/work/proj/.pi/skills");
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
  expect(out.map((p) => norm(p.dir))).toEqual(["/a/.pi/skills", "/b/.pi/skills"]);
});
