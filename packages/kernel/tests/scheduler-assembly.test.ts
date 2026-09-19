/**
 * 定时任务装配（Task 6）轻量验证：projectsProvider 组合逻辑。
 * 默认工作区永远在内（projects.json 未 seed 时也补上），普通项目按 projects.json 透传。
 */
import { describe, test, expect } from "bun:test";
import { buildSchedulerProjects } from "../src/scheduler-projects";
import { SYSTEM_PROJECT_ID, SYSTEM_PROJECT_CWD } from "@wa-pi/shared";

describe("buildSchedulerProjects", () => {
	test("包含默认工作区与普通项目", async () => {
		const projects = await buildSchedulerProjects(async () => [
			{ id: "p1", cwd: "/tmp/a" },
		]);
		expect(projects.some((p) => p.id === SYSTEM_PROJECT_ID)).toBe(true);
		expect(projects.some((p) => p.id === "p1")).toBe(true);
		// 默认工作区 cwd 指向 SYSTEM_PROJECT_CWD
		expect(projects.find((p) => p.id === SYSTEM_PROJECT_ID)?.cwd).toBe(
			SYSTEM_PROJECT_CWD,
		);
	});

	test("projects.json 已 seed 默认工作区时不重复追加", async () => {
		const projects = await buildSchedulerProjects(async () => [
			{ id: SYSTEM_PROJECT_ID, cwd: SYSTEM_PROJECT_CWD },
			{ id: "p1", cwd: "/tmp/a" },
		]);
		expect(projects.filter((p) => p.id === SYSTEM_PROJECT_ID).length).toBe(1);
		expect(projects.length).toBe(2);
	});
});
