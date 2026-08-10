import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ProjectList } from "../src/components/ProjectList";
import { useProjectsStore } from "../src/store/projects";
import { useProjectUiStore } from "../src/store/project-ui";
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";

// 渲染后清理 DOM：happy-dom 全局 document 跨测试文件共享，不清理会污染后续文件
afterEach(() => cleanup());

beforeEach(() => {
	useProjectsStore.setState({
		projects: [],
		sessions: [],
		currentProjectId: null,
		currentSessionId: null,
	});
	useProjectUiStore.setState({ collapsedProjectIds: [] });
});

test("渲染项目 + 会话", () => {
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "会话1",
				createdAt: 0,
				lastActivity: Date.now(),
				piSessionFile: "",
			},
		],
		currentProjectId: null,
		currentSessionId: null,
	});
	render(
		<ProjectList
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
			onNewProject={() => {}}
		/>,
	);
	expect(screen.getByText("项目A")).toBeTruthy();
	expect(screen.getByText("会话1")).toBeTruthy();
});

test("IM 渠道会话（im- 前缀）不在任务列表显示，只属于 IM 页签", () => {
	useProjectsStore.setState({
		projects: [
			{ id: SYSTEM_PROJECT_ID, name: "默认工作区", cwd: "/tmp", createdAt: 0 },
		],
		sessions: [
			{
				id: "normal-session",
				projectId: SYSTEM_PROJECT_ID,
				primaryAgent: "dev",
				title: "普通会话",
				createdAt: 0,
				lastActivity: Date.now(),
				piSessionFile: "",
			},
			{
				id: "im-ch_abc-__system__-1700000000000",
				projectId: SYSTEM_PROJECT_ID,
				primaryAgent: "前端开发者",
				title: "IM · woq4IJEAAAQW",
				createdAt: 0,
				lastActivity: Date.now(),
				piSessionFile: "",
			},
		],
		currentProjectId: null,
		currentSessionId: null,
	});
	render(
		<ProjectList
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
			onNewProject={() => {}}
		/>,
	);
	// 普通会话正常显示
	expect(screen.getByText("普通会话")).toBeTruthy();
	// IM 会话不在任务列表
	expect(screen.queryByText("IM · woq4IJEAAAQW")).toBeNull();
});

test("新建项目按钮", () => {
	const fn = mock();
	render(
		<ProjectList
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
			onNewProject={fn}
		/>,
	);
	// 无用户项目时不显示「项目」标题行，底部文字按钮是唯一新建入口
	expect(screen.queryByText("项目")).toBeNull();
	expect(screen.getByTestId("new-project-btn")).toBeTruthy();
	fireEvent.click(screen.getByTestId("new-project-btn"));
	expect(fn).toHaveBeenCalledTimes(1);
});

test("有用户项目时：新建入口为标题行右侧 + 图标，底部文字按钮隐藏", () => {
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
		sessions: [],
		currentProjectId: null,
		currentSessionId: null,
	});
	const fn = mock();
	render(
		<ProjectList
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
			onNewProject={fn}
		/>,
	);
	// + 图标按钮存在（与底部文字按钮共用 new-project-btn，但此时文字按钮不渲染）
	const iconBtn = screen.getByTestId("new-project-btn");
	expect(iconBtn).toBeTruthy();
	// 底部文字按钮不显示
	expect(screen.queryByText("＋ 新建项目")).toBeNull();
	// 点击 + 图标触发 onNewProject
	fireEvent.click(iconBtn);
	expect(fn).toHaveBeenCalledTimes(1);
});

test("在新会话界面但点击未选中的项目时，切换到该项目新会话，不折叠", () => {
	useProjectsStore.setState({
		projects: [
			{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 },
			{ id: "p2", name: "项目B", cwd: "/b", createdAt: 0 },
		],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "会话1",
				createdAt: 0,
				lastActivity: Date.now(),
				piSessionFile: "",
			},
			{
				id: "s2",
				projectId: "p2",
				primaryAgent: "dev",
				title: "会话2",
				createdAt: 0,
				lastActivity: Date.now(),
				piSessionFile: "",
			},
		],
		currentProjectId: "p1",
		currentSessionId: null,
	});
	const onSelectProject = mock();
	render(
		<ProjectList
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={onSelectProject}
			onNewProject={() => {}}
			currentView="new-session"
		/>,
	);
	fireEvent.click(screen.getByText("项目B"));
	expect(onSelectProject).toHaveBeenCalledWith("p2");
	// 项目 B 原本就是展开的，点击后不应改变折叠状态
	expect(screen.getByText("会话2")).toBeTruthy();
});

test("不在新会话界面时，点击项目名进入该项目新会话，不折叠项目", () => {
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "会话1",
				createdAt: 0,
				lastActivity: Date.now(),
				piSessionFile: "",
			},
		],
		currentProjectId: "p1",
		currentSessionId: "s1",
	});
	const onSelectProject = mock();
	render(
		<ProjectList
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={onSelectProject}
			onNewProject={() => {}}
			currentView="session"
		/>,
	);
	expect(screen.getByText("会话1")).toBeTruthy();
	fireEvent.click(screen.getByText("项目A"));
	expect(onSelectProject).toHaveBeenCalledWith("p1");
	expect(screen.getByText("会话1")).toBeTruthy();
});

test("在新会话界面且已选中该项目时，点击项目名展开/折叠", () => {
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "会话1",
				createdAt: 0,
				lastActivity: Date.now(),
				piSessionFile: "",
			},
		],
		currentProjectId: "p1",
		currentSessionId: null,
	});
	const onSelectProject = mock();
	render(
		<ProjectList
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={onSelectProject}
			onNewProject={() => {}}
			currentView="new-session"
		/>,
	);
	fireEvent.click(screen.getByText("项目A"));
	expect(onSelectProject).not.toHaveBeenCalled();
	expect(screen.queryByText("会话1")).toBeNull();
	fireEvent.click(screen.getByText("项目A"));
	expect(screen.getByText("会话1")).toBeTruthy();
});

test("项目处于折叠状态时，点击项目名同时跳转新建会话并展开列表", () => {
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "会话1",
				createdAt: 0,
				lastActivity: Date.now(),
				piSessionFile: "",
			},
		],
		currentProjectId: null,
		currentSessionId: null,
	});
	useProjectUiStore.setState({ collapsedProjectIds: ["p1"] });
	const onSelectProject = mock();
	render(
		<ProjectList
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={onSelectProject}
			onNewProject={() => {}}
			currentView="session"
		/>,
	);
	// 折叠状态看不到会话
	expect(screen.queryByText("会话1")).toBeNull();
	fireEvent.click(screen.getByText("项目A"));
	// 一次点击同时：跳转新建会话 + 展开列表
	expect(onSelectProject).toHaveBeenCalledWith("p1");
	expect(screen.getByText("会话1")).toBeTruthy();
});

test("项目折叠且已选中、处于新会话界面时，点击项目名仍同时跳转新建会话并展开（折叠优先于 toggle）", () => {
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "会话1",
				createdAt: 0,
				lastActivity: Date.now(),
				piSessionFile: "",
			},
		],
		currentProjectId: "p1",
		currentSessionId: null,
	});
	useProjectUiStore.setState({ collapsedProjectIds: ["p1"] });
	const onSelectProject = mock();
	render(
		<ProjectList
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={onSelectProject}
			onNewProject={() => {}}
			currentView="new-session"
		/>,
	);
	fireEvent.click(screen.getByText("项目A"));
	expect(onSelectProject).toHaveBeenCalledWith("p1");
	expect(screen.getByText("会话1")).toBeTruthy();
});

test("默认工作区渲染在项目列表顶部（无'默认'小标题）", () => {
	useProjectsStore.setState({
		projects: [
			{
				id: SYSTEM_PROJECT_ID,
				name: "默认工作区",
				cwd: "/tmp/workdir",
				createdAt: 0,
			},
			{ id: "p1", name: "WaPi", cwd: "/work/wa-pi", createdAt: 0 },
		],
		sessions: [],
		currentProjectId: null,
		currentSessionId: null,
	});
	render(
		<ProjectList
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
			onNewProject={() => {}}
		/>,
	);
	// 默认工作区项目渲染
	expect(screen.getByText("默认工作区")).toBeTruthy();
	// 无"默认"小标题（与"项目"区标题不同）
	expect(screen.queryByText("默认")).toBeNull();
});

test("默认工作区在 DOM 顺序上排在'项目'小标题之前 + 与项目同区滚动", () => {
	useProjectsStore.setState({
		projects: [
			{
				id: SYSTEM_PROJECT_ID,
				name: "默认工作区",
				cwd: "/tmp/workdir",
				createdAt: 0,
			},
			{ id: "p1", name: "WaPi", cwd: "/work/wa-pi", createdAt: 0 },
		],
		sessions: [],
		currentProjectId: null,
		currentSessionId: null,
	});
	const { container } = render(
		<ProjectList
			onSelectSession={() => {}}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
			onNewProject={() => {}}
		/>,
	);
	// 只有一处渲染"默认工作区"（去重）
	expect(screen.getAllByText("默认工作区").length).toBe(1);
	// 默认工作区的 testid 在 DOM 中出现在"项目"小标题之前
	const sysNode = container.querySelector(
		`[data-testid="project-${SYSTEM_PROJECT_ID}"]`,
	);
	const headerNode = screen.getByText("项目");
	expect(sysNode).toBeTruthy();
	expect(sysNode!.compareDocumentPosition(headerNode!)).toBe(
		Node.DOCUMENT_POSITION_FOLLOWING,
	);
});

test("点击会话激活：时间显示刷新为“刚刚”，但列表保持原位不立即重排", () => {
	const now = Date.now();
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "会话1",
				createdAt: 0,
				lastActivity: now - 10_000,
				piSessionFile: "",
			},
			{
				id: "s2",
				projectId: "p1",
				primaryAgent: "pm",
				title: "会话2",
				createdAt: 0,
				lastActivity: now - 5_000,
				piSessionFile: "",
			},
		],
		currentProjectId: "p1",
		currentSessionId: null,
	});
	// 用真实 store action 走完整链路：点击 → selectSession → lastActivity 更新 → 渲染
	render(
		<ProjectList
			onSelectSession={useProjectsStore.getState().selectSession}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
			onNewProject={() => {}}
		/>,
	);

	const titles = () =>
		screen.getAllByTestId(/^session-/).map((el) => el.textContent ?? "");
	// 初始：会话2（较新）在会话1（较旧）之上
	expect(titles()[0]).toContain("会话2");

	// 点击较旧会话 → 激活：时间显示更新为“刚刚”，但列表保持原位不立即重排（避免点错感）
	fireEvent.click(screen.getByText("会话1"));
	expect(titles()[0]).toContain("会话2");
	expect(titles()[1]).toContain("会话1");
	expect(screen.getByTestId("session-s1").textContent).toContain("刚刚");
	// 数据层 lastActivity 已更新（离开该会话后重排依据就绪）
	const s1 = useProjectsStore.getState().sessions.find((x) => x.id === "s1")!;
	expect(s1.lastActivity).toBeGreaterThan(now - 1000);
});

test("点击会话不改变列表顺序：离开当前项目后原项目保持原位（重排仅发生在折叠→展开）", () => {
	const now = Date.now();
	useProjectsStore.setState({
		projects: [
			{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 },
			{ id: "p2", name: "项目B", cwd: "/b", createdAt: 0 },
		],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "会话1",
				createdAt: 0,
				lastActivity: now - 10_000,
				piSessionFile: "",
			},
			{
				id: "s2",
				projectId: "p1",
				primaryAgent: "pm",
				title: "会话2",
				createdAt: 0,
				lastActivity: now - 5_000,
				piSessionFile: "",
			},
			{
				id: "s3",
				projectId: "p2",
				primaryAgent: "test",
				title: "会话3",
				createdAt: 0,
				lastActivity: now - 20_000,
				piSessionFile: "",
			},
		],
		currentProjectId: "p1",
		currentSessionId: null,
	});
	render(
		<ProjectList
			onSelectSession={useProjectsStore.getState().selectSession}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
			onNewProject={() => {}}
		/>,
	);

	// 点击 p1 的旧会话 s1 → 保持原位（不立即重排）
	fireEvent.click(screen.getByText("会话1"));
	let titles = screen
		.getAllByTestId(/^session-/)
		.map((el) => el.textContent ?? "");
	expect(titles[0]).toContain("会话2");
	expect(titles[1]).toContain("会话1");

	// 离开 p1：点击 p2 的会话 s3 → p1 顺序保持不变（点击会话永不触发重排）
	fireEvent.click(screen.getByText("会话3"));
	titles = screen.getAllByTestId(/^session-/).map((el) => el.textContent ?? "");
	expect(titles[0]).toContain("会话2");
	expect(titles[1]).toContain("会话1");
});

test("项目从折叠到展开时，按最近活跃重排会话", () => {
	const now = Date.now();
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "会话1",
				createdAt: 0,
				lastActivity: now - 10_000,
				piSessionFile: "",
			},
			{
				id: "s2",
				projectId: "p1",
				primaryAgent: "pm",
				title: "会话2",
				createdAt: 0,
				lastActivity: now - 5_000,
				piSessionFile: "",
			},
		],
		currentProjectId: "p1",
		currentSessionId: null,
	});
	render(
		<ProjectList
			onSelectSession={useProjectsStore.getState().selectSession}
			onNewSessionInProject={() => {}}
			onSelectProject={() => {}}
			onNewProject={() => {}}
		/>,
	);

	const titles = () =>
		screen.getAllByTestId(/^session-/).map((el) => el.textContent ?? "");
	// 初始：会话2（较新）在会话1（较旧）之上
	expect(titles()[0]).toContain("会话2");

	// 点击旧会话 s1 → 时间刷新但列表顺序保持
	fireEvent.click(screen.getByText("会话1"));
	expect(titles()[0]).toContain("会话2");
	expect(titles()[1]).toContain("会话1");

	// 折叠 p1 → 会话列表隐藏
	fireEvent.click(screen.getByTestId("project-toggle-p1"));
	expect(screen.queryByText("会话1")).toBeNull();

	// 展开 p1 → 按最近活跃重排：s1 已是最新，排到最顶
	fireEvent.click(screen.getByTestId("project-toggle-p1"));
	expect(titles()[0]).toContain("会话1");
	expect(titles()[1]).toContain("会话2");
});
