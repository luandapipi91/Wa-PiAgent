import { beforeEach, afterEach, test, expect, vi } from "bun:test";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { AboutSection } from "../src/components/settings/AboutSection";
import { useUpdaterStore, initUpdater } from "../src/store/updater";
import { useVersionHistoryStore } from "../src/store/version-history";
import versionHistory from "../src/data/version-history.json";

/**
 * AboutSection 组件测试（Task 9）。
 * 测试语言锁定中文（.env.test 的 WA_PI_LANG=zh），故断言文案与 zh.ts 的
 * settings.about.* 文案字面量一致。
 */

function mockUpdaterApi() {
	const listeners: Array<(p: Record<string, unknown>) => void> = [];
	const api = {
		getInfo: vi.fn(async () => ({
			appVersion: "0.1.0",
			isDesktop: true,
		})),
		check: vi.fn(async () => ({ ok: true })),
		download: vi.fn(async () => ({ ok: true })),
		quitAndInstall: vi.fn(async () => ({ ok: true })),
		onEvent: vi.fn((cb: (p: Record<string, unknown>) => void) => {
			listeners.push(cb);
			return () => {};
		}),
		_emit: (p: Record<string, unknown>) => listeners.forEach((cb) => cb(p)),
	};
	(window as any).waPiUpdater = api;
	return api;
}

beforeEach(() => {
	mockUpdaterApi();
	// initUpdater 订阅 mock api 的 onEvent，使测试的 _emit 能驱动 store 状态机
	initUpdater();
	useUpdaterStore.setState({
		status: "idle",
		appVersion: "0.1.0",
		latestVersion: null,
		releaseNotes: null,
		progress: 0,
		transferred: 0,
		total: 0,
		error: null,
		isDesktop: true,
	});
	localStorage.clear();
	useVersionHistoryStore.setState({
		entries: versionHistory as any,
		source: "bundled",
		loaded: false,
	});
});
afterEach(() => {
	cleanup();
	delete (window as any).waPiUpdater;
});

test("渲染应用名与版本号", () => {
	render(<AboutSection />);
	expect(screen.getByText("WA PI Agent")).toBeTruthy();
	expect(screen.getByText("版本 0.1.0")).toBeTruthy();
});

test("渲染官网外链（R2 公开渠道，新窗口打开）", () => {
	render(<AboutSection />);
	const link = screen.getByTestId("about-website-link") as HTMLAnchorElement;
	expect(link).toBeTruthy();
	expect(link.href).toBe("https://www.wapiagent.top/index.html");
	expect(link.target).toBe("_blank");
	expect(link.rel).toContain("noreferrer");
	expect(link.textContent).toBe("官方网站");
});

test("渲染 GitHub 外链（新窗口打开）", () => {
	render(<AboutSection />);
	const link = screen.getByTestId("about-github-link") as HTMLAnchorElement;
	expect(link.href).toBe("https://github.com/luandapipi91/Wa-PiAgent");
	expect(link.target).toBe("_blank");
	expect(link.rel).toContain("noreferrer");
	expect(link.textContent).toBe("GitHub");
});

test("idle 显示检查更新按钮，点击触发 check", () => {
	const api = (window as any).waPiUpdater;
	render(<AboutSection />);
	fireEvent.click(screen.getByText("检查更新"));
	expect(api.check).toHaveBeenCalled();
});

test("available 显示新版本与 release notes", () => {
	useVersionHistoryStore.setState({ entries: [] });
	(window as any).waPiUpdater._emit({
		phase: "available",
		version: "0.2.0",
		releaseNotes: "修复：文件预览持久化",
	});
	render(<AboutSection />);
	expect(screen.getByText(/0\.2\.0/)).toBeTruthy();
	expect(screen.getByText(/文件预览持久化/)).toBeTruthy();
	fireEvent.click(screen.getByText("立即更新"));
	expect((window as any).waPiUpdater.download).toHaveBeenCalled();
});

test("downloading 显示进度", () => {
	(window as any).waPiUpdater._emit({
		phase: "downloading",
		progress: 45,
		transferred: 57,
		total: 128,
	});
	render(<AboutSection />);
	expect(screen.getByText(/45%/)).toBeTruthy();
});

test("downloaded 显示重启安装按钮", () => {
	(window as any).waPiUpdater._emit({ phase: "downloaded", version: "0.2.0" });
	render(<AboutSection />);
	fireEvent.click(screen.getByText("立即重启安装"));
	expect((window as any).waPiUpdater.quitAndInstall).toHaveBeenCalled();
});

test("error 显示错误与重试", () => {
	(window as any).waPiUpdater._emit({ phase: "error", message: "网络失败" });
	render(<AboutSection />);
	expect(screen.getByText(/网络失败/)).toBeTruthy();
	fireEvent.click(screen.getByText("重试"));
	expect((window as any).waPiUpdater.check).toHaveBeenCalled();
});

test("非桌面环境（isDesktop=false）隐藏更新按钮", () => {
	useUpdaterStore.setState({ isDesktop: false });
	render(<AboutSection />);
	expect(screen.queryByText("检查更新")).toBeNull();
});

test("更新历史为左右分栏（列表 + 详情）", () => {
	render(<AboutSection />);
	expect(screen.getByTestId("version-history-list")).toBeTruthy();
	expect(screen.getByTestId("version-history-detail")).toBeTruthy();
});

test("available 时展示跨版本区间摘要，点查看全部展开各版本内容", () => {
	// 构造区间：安装版 0.1.0，最新版 0.2.0，历史里 0.2.0 与 0.1.21 均落在区间内
	useVersionHistoryStore.setState({
		entries: [
			{ version: "0.2.0", date: "2026-02-01", sections: { 修复: ["区间条目甲"] } },
			{ version: "0.1.21", date: "2026-01-05", sections: { 修复: ["区间条目乙"] } },
			{ version: "0.1.0", date: "2026-01-01", sections: { 修复: ["旧条目"] } },
		],
	});
	(window as any).waPiUpdater._emit({
		phase: "available",
		version: "0.2.0",
		releaseNotes: "修复：文件预览持久化",
	});
	render(<AboutSection />);
	expect(screen.getByText(/跨 2 个版本/)).toBeTruthy();
	// 断言限定在区间区块内：分栏右栏默认展示 entries[0]（也是 0.2.0）的正文，
	// 全局查文本会把右栏的「区间条目甲」误当成本区块已展开。
	expect(screen.queryByTestId("pending-versions")).toBeNull();
	fireEvent.click(screen.getByTestId("toggle-pending-versions"));
	const pending = within(screen.getByTestId("pending-versions"));
	expect(pending.getByText("区间条目甲")).toBeTruthy();
	expect(pending.getByText("区间条目乙")).toBeTruthy();
	// 负向断言用 queryByText：getByText 找不到元素时直接抛错，永远不可能为 null
	expect(screen.queryByText("旧条目")).toBeNull();
});

test("最新版在版本历史里：区间内容包含该版本（修复：新版本出现时看不到它的内容）", () => {
	useUpdaterStore.setState({ appVersion: "0.7.13" });
	useVersionHistoryStore.setState({
		entries: [
			{ version: "0.7.15", date: "2026-10-23", sections: { 修复: ["最新版本内容"] } },
			{ version: "0.7.14", date: "2026-10-23", sections: { 改进: ["中间版本内容"] } },
			{ version: "0.7.13", date: "2026-10-22", sections: { 改进: ["已安装版本内容"] } },
		],
	});
	(window as any).waPiUpdater._emit({
		phase: "available",
		version: "0.7.15",
		releaseNotes: "修复：最新版本内容",
	});
	render(<AboutSection />);
	expect(screen.getByText(/跨 2 个版本/)).toBeTruthy();
	fireEvent.click(screen.getByTestId("toggle-pending-versions"));
	const pending = within(screen.getByTestId("pending-versions"));
	expect(pending.getByText("最新版本内容")).toBeTruthy();
	expect(pending.getByText("中间版本内容")).toBeTruthy();
	expect(pending.queryByText("已安装版本内容")).toBeNull();
});

test("最新版不在版本历史里：不展示旧区间内容，退回 releaseNotes", () => {
	useUpdaterStore.setState({ appVersion: "0.7.12" });
	useVersionHistoryStore.setState({
		entries: [
			{ version: "0.7.13", date: "2026-10-22", sections: { 改进: ["旧版本条目"] } },
		],
	});
	(window as any).waPiUpdater._emit({
		phase: "available",
		version: "0.7.15",
		releaseNotes: "修复：委托记录弹窗历史轮次显示不全",
	});
	render(<AboutSection />);
	// 历史数据迟到（内核缓存 / 线上未更新）时，区间不可信：必须显示新版本自己的
	// releaseNotes，而不是拿更旧的版本内容冒充「本次更新内容」
	expect(screen.getByTestId("release-notes-body").textContent).toContain(
		"委托记录弹窗",
	);
	expect(screen.queryByTestId("toggle-pending-versions")).toBeNull();
	// 限定在状态条内：分栏右栏默认展示 entries[0]（0.7.13）的正文，全局查会误命中
	expect(
		within(screen.getByTestId("updater-status")).queryByText("旧版本条目"),
	).toBeNull();
});

test("发现新版本但历史里没有它：强制刷新版本历史（且只刷一次）", async () => {
	const originalLoad = useVersionHistoryStore.getState().load;
	const load = vi.fn(async (_force?: boolean) => {});
	useVersionHistoryStore.setState({
		load: load as never,
		entries: [
			{ version: "0.7.13", date: "2026-10-22", sections: { 改进: ["旧版本条目"] } },
		],
	});
	(window as any).waPiUpdater._emit({
		phase: "available",
		version: "0.7.15",
		releaseNotes: "新内容",
	});
	render(<AboutSection />);
	await waitFor(() => expect(load.mock.calls.some((c) => c[0] === true)).toBe(true));
	expect(load.mock.calls.filter((c) => c[0] === true).length).toBe(1);
	useVersionHistoryStore.setState({ load: originalLoad });
});
