// 结构层（任务 3）：token 数值独立元素 + 会话头 tag/引线 + 连接状态点。
// 纯 CSS 做不出「数值单独成方块」，必须先把 DOM 拆开，故这些装饰的契约在这里锁住：
// 数值必须是**独立元素**且 textContent 只含数字本身（否则各主题无法单独染色/加底色）。
import "./mock-composer-db";
import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, cleanup, act } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { TokenCapsules } from "../src/components/TokenCapsules";
import { SessionView } from "../src/components/SessionView";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";
import { useUiPrefsStore } from "../src/store/ui-prefs";
import { disconnectEvents } from "../src/events";

// SessionView 挂载会打 /messages、/stats：给空响应即可（本文件不验证这些链路）
mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve({ messages: [] }),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
	ApiError: class extends Error {
		status: number;
		constructor(m: string, s: number) {
			super(m);
			this.status = s;
			this.name = "ApiError";
		}
	},
}));

afterEach(() => cleanup());

beforeEach(() => {
	disconnectEvents();
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "P", cwd: "/work/p1", createdAt: 0 }],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "测试",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "",
			},
		],
		currentProjectId: "p1",
		currentSessionId: "s1",
	});
	useSessionStore.setState({
		messagesBySession: {},
		historyLoadingBySession: {},
		lastUsageBySession: {},
		tokenTotals: {},
		contextUsageBySession: {},
		netStatusBySession: {},
		statusBySession: {},
	});
	useUiPrefsStore.setState({ themeMode: "system" });
});

const FULL_PROPS = {
	lastUsage: { input: 513, output: 242, cacheRead: 0, cacheWrite: 0 },
	// 累计 39.7M、主 30M / 子 9.7M；缓存命中 96.8% = 968/(32+968+0)
	tokenTotal: {
		input: 32,
		output: 200,
		cacheRead: 968,
		cacheWrite: 0,
		total: 39_700_000,
		main: 30_000_000,
		subagent: 9_700_000,
	},
	contextUsage: { used: 250_000, total: 1_000_000, ratio: 0.25 },
} as const;

function renderCapsules(props: any = FULL_PROPS) {
	return render(<TokenCapsules {...props} />);
}

test("token 数值各自是独立元素，textContent 只含数值本身", () => {
	const { container } = renderCapsules();
	const val = (id: string) =>
		container.querySelector(`[data-testid="${id}"]`)?.textContent;
	// 本轮 ↑/↓ 各自独立：CSS 才能把数字单独做成方块
	expect(val("token-value-input")).toBe("513");
	expect(val("token-value-output")).toBe("242");
	// 占用 / 累计 / 缓存 同样独立
	expect(val("token-value-used")).toBe("250K");
	expect(val("token-value-total")).toBe("39.7M");
	expect(val("token-value-cache")).toBe("96.8%");
});

test("token 标签文案仍完整可见（拆数值不丢标签）", () => {
	renderCapsules();
	expect(screen.getByTestId("token-capsule-turn").textContent).toContain("本轮");
	expect(screen.getByTestId("token-occupied").textContent).toContain("占用");
	expect(screen.getByTestId("token-total").textContent).toContain("累计");
	// 缓存胶囊无 testid（沿用既有结构），按可见文案断言
	expect(screen.getByText(/缓存/)).toBeTruthy();
});

test("骨架屏占位保留：stats 未返回且无累计时渲染骨架，不渲染累计胶囊", () => {
	renderCapsules({
		lastUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
		skeleton: true,
	});
	expect(screen.getByTestId("token-capsules-skeleton")).toBeTruthy();
	expect(screen.queryByTestId("token-total")).toBeNull();
});

test("danger 变体保留：缓存命中率 <90% 时带 token-capsule--cache-danger", () => {
	const { container } = renderCapsules({
		lastUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
		tokenTotal: {
			input: 5000,
			output: 0,
			cacheRead: 1000,
			cacheWrite: 0,
			total: 6000,
		},
	});
	const cache = container.querySelector(".token-capsule--cache")!;
	expect(cache.className).toContain("token-capsule--cache-danger");
	expect(cache.textContent).toContain("16.6%");
});

test("进度条保留：占用占比按 contextUsage 换算，极小占比保留最小可见宽度", () => {
	const { container } = renderCapsules();
	const fill = container.querySelector(".token-progress-fill") as HTMLElement;
	expect(fill.style.width).toBe("25%");

	cleanup();
	const tiny = renderCapsules({
		lastUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextUsage: { used: 1, total: 1_000_000, ratio: 0 },
	});
	const tinyFill = tiny.container.querySelector(
		".token-progress-fill",
	) as HTMLElement;
	expect(parseFloat(tinyFill.style.width)).toBeGreaterThan(0);
});

test("子代理消耗时累计拆分仍在（主/子两段）", () => {
	renderCapsules();
	expect(screen.getByTestId("token-split").textContent).toContain("主 30M");
	expect(screen.getByTestId("token-split").textContent).toContain("子 9.7M");
});

test("无 usage 且无骨架时不渲染胶囊组", () => {
	renderCapsules({});
	expect(screen.queryByTestId("token-capsules")).toBeNull();
});

// ===== 会话头结构 =====
async function renderHeader() {
	render(
		<VirtuosoMockContext.Provider
			value={{ viewportHeight: 800, itemHeight: 60 }}
		>
			<SessionView sessionId="s1" />
		</VirtuosoMockContext.Provider>,
	);
	await act(async () => {});
}

test("会话头：路径与状态各自独立成元素（可直接单独染色）", async () => {
	await renderHeader();
	const path = screen.getByTestId("session-path");
	const status = screen.getByTestId("session-status-tag");
	expect(path.textContent).toContain("/work/p1");
	expect(status.textContent?.trim()).toBe("空闲");
	// 两者不互相包含：路径元素里不能再夹状态文案
	expect(path.textContent).not.toContain("空闲");
	// 角色入口（AgentSwitcher 只读）仍在同一行
	expect(screen.queryByTestId("agent-switcher")).toBeTruthy();
});

test("会话头：状态 tag 跟随运行态文案", async () => {
	useSessionStore.setState({ statusBySession: { s1: "thinking" } });
	await renderHeader();
	expect(screen.getByTestId("session-status-tag").textContent?.trim()).toBe(
		"思考中",
	);
});

test("引线标注只在战术主题渲染（其余主题 DOM 里不该有）", async () => {
	useUiPrefsStore.setState({ themeMode: "gilded" });
	await renderHeader();
	expect(screen.queryByTestId("session-main-thread")).toBeNull();
	cleanup();

	useUiPrefsStore.setState({ themeMode: "tactical" });
	await renderHeader();
	expect(screen.getByTestId("session-main-thread").textContent).toContain(
		"主线程 · MAIN",
	);
});

test("连接状态点：正常时 ok，Provider 降级时 degraded（不是假绿灯）", async () => {
	await renderHeader();
	expect(screen.getByTestId("session-conn-led").getAttribute("data-state")).toBe(
		"ok",
	);

	act(() => {
		useSessionStore.setState({ netStatusBySession: { s1: "degraded" } });
	});
	expect(screen.getByTestId("session-conn-led").getAttribute("data-state")).toBe(
		"degraded",
	);
});
