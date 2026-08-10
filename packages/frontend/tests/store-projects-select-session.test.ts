import { test, expect, beforeEach } from "bun:test";
import { useProjectsStore } from "../src/store/projects";

beforeEach(() => {
	useProjectsStore.setState({
		projects: [],
		sessions: [],
		currentProjectId: null,
		currentSessionId: null,
	});
});

test("selectSession 同步 currentProjectId 到选中会话所属项目", () => {
	useProjectsStore.setState({
		projects: [
			{ id: "p1", name: "项目A", cwd: "/a", createdAt: 1 },
			{ id: "p2", name: "项目B", cwd: "/b", createdAt: 2 },
		],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "会话1",
				createdAt: 1,
				lastActivity: 1,
				piSessionFile: "",
			},
			{
				id: "s2",
				projectId: "p2",
				primaryAgent: "dev",
				title: "会话2",
				createdAt: 2,
				lastActivity: 2,
				piSessionFile: "",
			},
		],
		currentProjectId: "p1",
		currentSessionId: "s1",
	});

	// 选中项目 B 的会话
	useProjectsStore.getState().selectSession("s2");

	expect(useProjectsStore.getState().currentSessionId).toBe("s2");
	expect(useProjectsStore.getState().currentProjectId).toBe("p2");
});

test("连续切换不同项目的会话，currentProjectId 正确跟随", () => {
	useProjectsStore.setState({
		projects: [
			{ id: "p1", name: "项目A", cwd: "/a", createdAt: 1 },
			{ id: "p2", name: "项目B", cwd: "/b", createdAt: 2 },
		],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "会话1",
				createdAt: 1,
				lastActivity: 1,
				piSessionFile: "",
			},
			{
				id: "s2",
				projectId: "p2",
				primaryAgent: "dev",
				title: "会话2",
				createdAt: 2,
				lastActivity: 2,
				piSessionFile: "",
			},
		],
		currentProjectId: "p2",
	});

	useProjectsStore.getState().selectSession("s1");
	expect(useProjectsStore.getState().currentProjectId).toBe("p1");

	useProjectsStore.getState().selectSession("s2");
	expect(useProjectsStore.getState().currentProjectId).toBe("p2");
});
