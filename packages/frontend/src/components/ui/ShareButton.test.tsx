// ShareButton 交互测试：点击按钮 → 打开弹层 → 检查 token → 生成分享链接 →
// 显示 URL / 复制按钮 / 有效期；未配置 token 显示引导；复制走 util/clipboard。
// share-client 与 clipboard 整模块 mock（bun mock.module 路径须与组件 import 一致）。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const shareSettingsMock = mock(async () => ({
	hasToken: true,
	channel: "edgeone",
}));
const shareUploadMock = mock(async () => ({}));
const shareNameForPathsMock = mock(
	async (): Promise<{ name: string | null }> => ({ name: null }),
);
const copyMock = mock(async (..._args: any[]) => {});

mock.module("../../share-client", () => ({
	shareSettings: shareSettingsMock,
	shareUpload: shareUploadMock,
	shareNameForPaths: shareNameForPathsMock,
	saveShareSettings: async () => {},
}));
mock.module("../../util/clipboard", () => ({
	copyToClipboard: copyMock,
	copyImageToClipboard: async () => {},
}));

import { ShareButton } from "./ShareButton";
import { useShareProgressStore } from "../../store/share-progress";
import { useToastStore } from "../../store/toast";
import { useSettingsStore } from "../../store/settings";

const PATHS = ["/proj/a.txt", "/proj/b.txt", "/proj/c.txt"];
const URL = "https://share.edgeone.app/s/xyz789";

beforeEach(() => {
	shareSettingsMock.mockReset();
	shareUploadMock.mockReset();
	shareNameForPathsMock.mockReset();
	copyMock.mockReset();
	useShareProgressStore.setState({ phase: "idle", percent: 0 });
	useSettingsStore.setState({ showSettings: false, activeSection: "general" });
	shareSettingsMock.mockResolvedValue({
		hasToken: true,
		channel: "edgeone",
	});
	shareNameForPathsMock.mockResolvedValue({ name: null });
	shareUploadMock.mockResolvedValue({
		url: URL,
		expiresAt: Date.now() + 3 * 3600 * 1000,
		projectName: "proj",
		channel: "edgeone",
	});
});

test("点击按钮打开弹层：显示文件数与首几个文件名 + 生成按钮", async () => {
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByText("3 个文件");
	expect(screen.getByTestId("share-result-modal")).toBeTruthy();
	expect(screen.getByText("a.txt")).toBeTruthy();
	expect(screen.getByText("b.txt")).toBeTruthy();
	expect(screen.getByText("c.txt")).toBeTruthy();
	expect(screen.getByTestId("share-generate-btn")).toBeTruthy();
});

test("生成分享链接：显示 URL + 复制按钮 + 「3 小时内有效」", async () => {
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-files");
	fireEvent.click(screen.getByTestId("share-generate-btn"));
	await screen.findByTestId("share-url");
	expect(shareUploadMock).toHaveBeenCalledWith(PATHS, undefined, "3 个文件");
	expect(screen.getByTestId("share-url").textContent).toContain(URL);
	expect(screen.getByTestId("share-copy-btn")).toBeTruthy();
	expect(screen.getByTestId("share-expires").textContent).toContain(
		"3 小时内有效",
	);
});

test("expiresAt=0（CF 渠道永久分享）：显示「永久有效」而非小时倒计时", async () => {
	shareUploadMock.mockResolvedValue({
		url: "https://wapi-shares.pages.dev/foo/",
		expiresAt: 0,
		projectName: "wapi-shares",
		channel: "cloudflare",
	});
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-files");
	fireEvent.click(screen.getByTestId("share-generate-btn"));
	await screen.findByTestId("share-url");
	expect(screen.getByTestId("share-expires").textContent).toContain("永久有效");
	expect(screen.getByTestId("share-expires").textContent).not.toContain("小时");
});

test("未配置 token：点击分享自动打开设置弹窗并切到「分享」tab，关闭分享弹窗", async () => {
	shareSettingsMock.mockResolvedValue({ hasToken: false, channel: "edgeone" });
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	// 检查到未配置分享参数 → 自动打开设置并定位到分享 tab（配 token 的地方）
	await waitFor(() =>
		expect(useSettingsStore.getState().showSettings).toBe(true),
	);
	expect(useSettingsStore.getState().activeSection).toBe("share");
	// 分享弹窗自动关闭，让位给设置弹窗
	await waitFor(() =>
		expect(screen.queryByTestId("share-result-modal")).toBeNull(),
	);
});

test("复制链接：copyToClipboard 收到分享 URL 且按钮显示「已复制」", async () => {
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-files");
	fireEvent.click(screen.getByTestId("share-generate-btn"));
	await screen.findByTestId("share-copy-btn");
	fireEvent.click(screen.getByTestId("share-copy-btn"));
	await screen.findByText("已复制");
	expect(copyMock).toHaveBeenCalledWith(URL);
});

test("复制失败：显示「复制失败」提示且按钮仍为「复制链接」", async () => {
	copyMock.mockRejectedValue(new Error("clipboard blocked"));
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-files");
	fireEvent.click(screen.getByTestId("share-generate-btn"));
	await screen.findByTestId("share-copy-btn");
	fireEvent.click(screen.getByTestId("share-copy-btn"));
	await screen.findByTestId("share-error");
	expect(screen.getByTestId("share-error").textContent).toContain("复制失败");
	expect(screen.getByTestId("share-copy-btn").textContent).toBe("复制链接");
});

test("生成中显示进度条：uploading 阶段显示真实百分比", async () => {
	// shareUpload 挂起保持 generating 态；模拟 kernel SSE 推送的 uploading 进度
	shareUploadMock.mockImplementation(() => new Promise(() => {}));
	useShareProgressStore.setState({ phase: "uploading", percent: 42 });
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-files");
	fireEvent.click(screen.getByTestId("share-generate-btn"));
	await screen.findByTestId("share-progress");
	expect(screen.getByTestId("share-progress-text").textContent).toContain("42%");
	expect(screen.getByTestId("progress-bar-fill").style.width).toBe("42%");
});

test("生成中 deploying 阶段显示 indeterminate 进度条", async () => {
	shareUploadMock.mockImplementation(() => new Promise(() => {}));
	useShareProgressStore.setState({ phase: "deploying", percent: 100 });
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-files");
	fireEvent.click(screen.getByTestId("share-generate-btn"));
	await screen.findByTestId("share-progress");
	expect(screen.getByTestId("progress-bar-indeterminate")).toBeTruthy();
	expect(screen.getByTestId("share-progress-text").textContent).toContain(
		"部署中",
	);
});

test("分享名称：默认自动名（多文件 = N 个文件），可修改并传给 shareUpload", async () => {
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-name-input");
	// 默认名
	expect(
		(screen.getByTestId("share-name-input") as HTMLInputElement).value,
	).toBe("3 个文件");
	// 修改
	fireEvent.change(screen.getByTestId("share-name-input"), {
		target: { value: "周报" },
	});
	fireEvent.click(screen.getByTestId("share-generate-btn"));
	await screen.findByTestId("share-url");
	expect(shareUploadMock).toHaveBeenCalledWith(PATHS, undefined, "周报");
});

test("分享名称：传入 projectName 时默认值 = 项目名，生成时传给 shareUpload", async () => {
	render(<ShareButton paths={PATHS} projectName="HiAgent" />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-name-input");
	expect(
		(screen.getByTestId("share-name-input") as HTMLInputElement).value,
	).toBe("HiAgent");
	fireEvent.click(screen.getByTestId("share-generate-btn"));
	await screen.findByTestId("share-url");
	expect(shareUploadMock).toHaveBeenCalledWith(PATHS, undefined, "HiAgent");
});

test("分享名称：传入空白 projectName 时回退自动名", async () => {
	render(<ShareButton paths={PATHS} projectName="   " />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-name-input");
	expect(
		(screen.getByTestId("share-name-input") as HTMLInputElement).value,
	).toBe("3 个文件");
});

test("分享同名：返回 merged 标志时 toast 提示「已合并到分享」，URL 正常显示", async () => {
	// kernel 现在同名合并（不再 409）：upload 返回 merged=true + filesCount
	shareUploadMock.mockResolvedValue({
		url: URL,
		expiresAt: Date.now() + 3 * 3600 * 1000,
		projectName: "proj",
		channel: "edgeone",
		merged: true,
		filesCount: 5,
	});
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-name-input");
	fireEvent.click(screen.getByTestId("share-generate-btn"));
	await screen.findByTestId("share-url");
	// URL 正常显示（合并不是失败）
	expect(screen.queryByTestId("share-error")).toBeNull();
	// 合并 toast 提示
	const toast = useToastStore
		.getState()
		.toasts.find((t) => t.message.includes("已合并到分享"));
	expect(toast?.type).toBe("success");
	expect(toast?.message).toContain("5");
});

test("分享名称非法字符：kernel 409 时提示错误且不显示 URL", async () => {
	shareUploadMock.mockRejectedValue(
		new Error("分享名称含非法字符（仅限字母/数字/中文/-_./空格）"),
	);
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-name-input");
	fireEvent.click(screen.getByTestId("share-generate-btn"));
	await screen.findByTestId("share-error");
	expect(screen.getByTestId("share-error").textContent).toContain("非法字符");
	expect(screen.queryByTestId("share-url")).toBeNull();
});

test("分享弹窗点击阴影不关闭（防误触丢输入），X 按钮可关闭", async () => {
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-result-modal");
	// 点遮罩 → 弹窗仍在（不关闭）
	fireEvent.click(screen.getByTestId("modal-overlay"));
	expect(screen.getByTestId("share-result-modal")).toBeTruthy();
	// X 按钮 → 关闭
	fireEvent.click(screen.getByTestId("share-close"));
	await waitFor(() =>
		expect(screen.queryByTestId("share-result-modal")).toBeNull(),
	);
});

test("再次分享同组文件：弹窗预填充上次分享名", async () => {
	shareNameForPathsMock.mockResolvedValue({ name: "别名A" });
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	// 查询历史名并回填到输入框
	await waitFor(() =>
		expect(
			(screen.getByTestId("share-name-input") as HTMLInputElement).value,
		).toBe("别名A"),
	);
});

test("无历史分享名：弹窗保持默认名（文件数）", async () => {
	shareNameForPathsMock.mockResolvedValue({ name: null });
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-name-input");
	expect(
		(screen.getByTestId("share-name-input") as HTMLInputElement).value,
	).toBe("3 个文件");
});

test("用户已手动改过输入框：历史名回填不覆盖用户输入", async () => {
	// 先 resolve 一个历史名，但用户已经手动改了 → 不应覆盖
	let resolveLookup!: (v: { name: string | null }) => void;
	shareNameForPathsMock.mockImplementation(
		() =>
			new Promise((r) => {
				resolveLookup = r;
			}),
	);
	render(<ShareButton paths={PATHS} />);
	fireEvent.click(screen.getByTestId("share-btn"));
	await screen.findByTestId("share-name-input");
	// 用户手动改名
	fireEvent.change(screen.getByTestId("share-name-input"), {
		target: { value: "我改的" },
	});
	// 历史名查询此刻才完成
	resolveLookup({ name: "别名A" });
	await waitFor(() =>
		expect(
			(screen.getByTestId("share-name-input") as HTMLInputElement).value,
		).toBe("我改的"),
	);
});
