import { beforeEach, afterEach, test, expect, vi } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AboutSection } from "../src/components/settings/AboutSection";
import { useUpdaterStore, initUpdater } from "../src/store/updater";

/**
 * AboutSection 组件测试（Task 9）。
 * 测试语言锁定中文（.env.test 的 WA_PI_LANG=zh），故断言文案与 zh.ts 的
 * settings.about.* 文案字面量一致。
 */

function mockUpdaterApi() {
	const listeners: Array<(p: Record<string, unknown>) => void> = [];
	const api = {
		getInfo: vi.fn(async () => ({ appVersion: "0.1.0", isDesktop: true })),
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
		kernelVersion: null,
		releaseNotes: null,
		progress: 0,
		transferred: 0,
		total: 0,
		error: null,
		isDesktop: true,
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

test("渲染内核版本（kernelVersion；为 null 时兜底“—”）", () => {
	useUpdaterStore.setState({ kernelVersion: "20260824-2" });
	render(<AboutSection />);
	expect(screen.getByText("内核版本 20260824-2")).toBeTruthy();

	useUpdaterStore.setState({ kernelVersion: null });
	cleanup();
	render(<AboutSection />);
	expect(screen.getByText("内核版本 —")).toBeTruthy();
});

test("idle 显示检查更新按钮，点击触发 check", () => {
	const api = (window as any).waPiUpdater;
	render(<AboutSection />);
	fireEvent.click(screen.getByText("检查更新"));
	expect(api.check).toHaveBeenCalled();
});

test("available 显示新版本与 release notes", () => {
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
