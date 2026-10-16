// ShareSection 设置面板测试：
// 1. 默认渲染：渠道选择（edgeone 选中）+ Token 输入框
// 2. 输入 Token 保存 → PUT /api/settings/share（断言 body.share.token / channel / accountId / customDomain）
// 3. 已保存 Token 时输入框脱敏展示（•••）+ 「修改」切换
// 4. 注册入口链接按语言分流（zh → /zh/products/pages；en → /products/pages）
// 5. 切换到 Cloudflare 渠道：显示 Account ID 输入框 + 注册链接 + 提示文案，保存带 accountId
// 6. 我的分享：列表渲染 / 删除 / 复制链接 / 立即部署 / pending 提示
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShareSection } from "./ShareSection";
import { useUiPrefsStore } from "../../store/ui-prefs";
import { useShareProgressStore } from "../../store/share-progress";

const getMock = mock();
const putMock = mock();
mock.module("../../api-client", () => ({
	api: {
		get: getMock,
		post: () => Promise.resolve({}),
		put: putMock,
		del: () => Promise.resolve({}),
	},
}));

// share-client 整模块 mock：避免真实 transport 发请求
const shareListMock = mock();
const shareDeleteMock = mock();
const shareClearMock = mock();
const shareDeployMock = mock();
const shareRefreshLinkMock = mock();
const shareOpenFolderMock = mock();
const shareRenameMock = mock();
const shareSpacesFactoryMock = mock(async (): Promise<unknown[]> => []);
const shareAddSpaceFactoryMock = mock(async () => ({}));
const shareDeleteSpaceFactoryMock = mock(async () => ({ notice: "" }));
mock.module("../../share-client", () => ({
	shareList: shareListMock,
	shareDelete: shareDeleteMock,
	shareClear: shareClearMock,
	shareDeploy: shareDeployMock,
	shareRefreshLink: shareRefreshLinkMock,
	shareOpenFolder: shareOpenFolderMock,
	shareRename: shareRenameMock,
	shareSpaces: shareSpacesFactoryMock,
	shareAddSpace: shareAddSpaceFactoryMock,
	shareDeleteSpace: shareDeleteSpaceFactoryMock,
}));

const copyMock = mock();
mock.module("../../util/clipboard", () => ({
	copyToClipboard: copyMock,
	copyImageToClipboard: () => Promise.resolve(),
}));

const emptyList = {
	items: [],
	pending: 0,
	totalSize: 0,
	totalLimit: 0,
	workspaceDir: "/tmp/ws-test",
};

/** 渲染并切到「我的分享」tab（管理类用例的前置） */
async function renderSharesTab() {
	const r = render(<ShareSection />);
	await screen.findByTestId("share-section");
	fireEvent.click(screen.getByTestId("share-tab-shares"));
	await screen.findByTestId("share-manage");
	return r;
}

beforeEach(() => {
	getMock.mockReset();
	putMock.mockReset();
	getMock.mockImplementation(async () => ({ share: {} }));
	putMock.mockImplementation(async () => ({}));
	shareListMock.mockReset();
	shareDeleteMock.mockReset();
	shareClearMock.mockReset();
	shareRenameMock.mockReset();
	shareDeployMock.mockReset();
	shareRefreshLinkMock.mockReset();
	shareOpenFolderMock.mockReset();
	shareSpacesFactoryMock.mockReset();
	shareAddSpaceFactoryMock.mockReset();
	shareDeleteSpaceFactoryMock.mockReset();
	shareSpacesFactoryMock.mockResolvedValue([]);
	copyMock.mockReset();
	shareListMock.mockImplementation(async () => emptyList);
	shareDeleteMock.mockImplementation(async () => {});
	shareClearMock.mockImplementation(async () => {});
	shareDeployMock.mockImplementation(async () => {});
	shareOpenFolderMock.mockImplementation(async () => {});
	copyMock.mockImplementation(async () => {});
	useUiPrefsStore.setState({ language: "zh" });
	useShareProgressStore.setState({ phase: "idle", percent: 0 });
});

test("默认渲染渠道「腾讯 EdgeOne」（只读）与 Token 输入框", async () => {
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	// 渠道只读展示
	expect(screen.getByText("腾讯 EdgeOne")).toBeTruthy();
	// 无已保存 Token → 显示输入框
	const input = screen.getByTestId("share-token-input");
	expect(input).toBeTruthy();
	expect((input as HTMLInputElement).value).toBe("");
	// 无掩码展示
	expect(screen.queryByTestId("share-token-mask")).toBeNull();
});

test("帮助弹窗：点 Token 旁 ? → 图文指引（示意图 + 步骤），✕ 按钮与 ESC 均可关闭", async () => {
	render(<ShareSection />);
	await screen.findByTestId("share-section");

	// 默认 edgeone 渠道：Token 帮助 → EdgeOne 指引（含示意图 + 步骤 + 关闭按钮）
	fireEvent.click(screen.getByTestId("share-token-help"));
	await screen.findByTestId("share-help-modal");
	expect(screen.getByText(/获取 EdgeOne API Token/)).toBeTruthy();
	// 示意图与步骤中多处出现「API Token」（Tab + 创建按钮 + 步骤文案）
	expect(screen.getAllByText(/API Token/).length).toBeGreaterThan(0);
	expect(screen.getByRole("img", { name: /Makers 控制台/ })).toBeTruthy();
	// 关闭按钮 ✕
	expect(screen.getByTestId("share-help-close")).toBeTruthy();
	fireEvent.click(screen.getByTestId("share-help-close"));
	await waitFor(() =>
		expect(screen.queryByTestId("share-help-modal")).toBeNull(),
	);

	// 切 Cloudflare：Token 帮助 → Cloudflare 指引（示意图 + 步骤）；ESC 关闭
	fireEvent.click(screen.getByTestId("share-channel-cloudflare"));
	fireEvent.click(screen.getByTestId("share-token-help"));
	await screen.findByTestId("share-help-modal");
	expect(screen.getByText(/获取 Cloudflare API Token/)).toBeTruthy();
	// 示意图与步骤中均出现模板名
	expect(screen.getAllByText(/Edit Cloudflare Workers/).length).toBeGreaterThan(
		0,
	);
	expect(
		screen.getByRole("img", { name: /Cloudflare API Tokens/ }),
	).toBeTruthy();
	fireEvent.keyDown(window, { key: "Escape" });
	await waitFor(() =>
		expect(screen.queryByTestId("share-help-modal")).toBeNull(),
	);
});

test("输入 Token 保存 → PUT /api/settings/share（body.share.token）", async () => {
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	const input = screen.getByTestId("share-token-input");
	fireEvent.change(input, { target: { value: "edgeone-token-xyz" } });
	fireEvent.click(screen.getByTestId("share-token-save"));
	await new Promise((r) => setTimeout(r, 10));
	expect(putMock).toHaveBeenCalledWith("/api/settings/share", {
		share: {
			token: "edgeone-token-xyz",
			channel: "edgeone",
			accountId: "",
			customDomain: "",
		},
	});
});

test("已保存 Token 时输入框脱敏展示（•••）+「修改」切换", async () => {
	// mount 回填：GET /api/settings/share 返回 hasToken: true（token 不明文下发）
	getMock.mockImplementation(async () => ({
		share: { hasToken: true, channel: "edgeone" },
	}));
	render(<ShareSection />);
	// 有已保存 token → 显示掩码而非输入框
	await screen.findByTestId("share-token-mask");
	expect(screen.getByText("••••••••")).toBeTruthy();
	expect(screen.queryByTestId("share-token-input")).toBeNull();
	// 点「修改」→ 切回输入框
	fireEvent.click(screen.getByTestId("share-token-modify"));
	expect(screen.getByTestId("share-token-input")).toBeTruthy();
	expect(screen.queryByTestId("share-token-mask")).toBeNull();
});

test("注册入口链接按语言分流：zh → /zh/products/pages；en → /products/pages", async () => {
	const { unmount } = render(<ShareSection />);
	const zhLink = await screen.findByTestId("share-register-link");
	expect(zhLink.getAttribute("href")).toBe(
		"https://edgeone.ai/zh/products/pages",
	);
	expect(zhLink.getAttribute("target")).toBe("_blank");
	unmount();

	useUiPrefsStore.setState({ language: "en" });
	render(<ShareSection />);
	const enLink = await screen.findByTestId("share-register-link");
	expect(enLink.getAttribute("href")).toBe("https://edgeone.ai/products/pages");
});

test("我的分享：shareList 返回 2 条 → 渲染名称/大小；空列表显示 empty 文案", async () => {
	shareListMock.mockImplementation(async () => ({
		items: [
			{
				id: "s1",
				name: "proj-a",
				files: ["index.html"],
				size: 2048,
				createdAt: 1780000000000,
			},
			{
				id: "s2",
				name: "proj-b",
				files: ["index.html", "a.js"],
				size: 2097152,
				createdAt: 1780000000000,
			},
		],
		pending: 0,
		totalSize: 2099200,
		totalLimit: 104857600,
	}));
	const { unmount } = await renderSharesTab();
	await screen.findByTestId("share-item-s1");
	expect(screen.getByTestId("share-item-s2")).toBeTruthy();
	expect(screen.getByText("proj-a")).toBeTruthy();
	expect(screen.getByText("proj-b")).toBeTruthy();
	// formatSize：2048 → 2 KB；2097152 → 2.0 MB
	expect(screen.getByText("2 KB")).toBeTruthy();
	expect(screen.getByText("2.0 MB")).toBeTruthy();
	// 非空列表显示「清空」按钮
	expect(screen.getByTestId("share-clear")).toBeTruthy();
	unmount();

	// 空列表 → empty 文案，无「清空」按钮
	shareListMock.mockImplementation(async () => emptyList);
	await renderSharesTab();
	expect(screen.getByText("暂无分享")).toBeTruthy();
	expect(screen.queryByTestId("share-clear")).toBeNull();
});

test("我的分享空间筛选：CF 渠道下拉切换（全部/默认/自定义），edgeone 渠道无下拉", async () => {
	// CF 渠道：空间列表（默认 + 自定义「博客」）+ 分享条目分属两个空间
	getMock.mockImplementation(async () => ({
		share: { hasToken: true, channel: "cloudflare" },
	}));
	shareSpacesFactoryMock.mockResolvedValue(cfSpaces);
	shareListMock.mockImplementation(async () => ({
		items: [
			// 存量记录无 cfSpaceId → 默认空间
			{
				id: "s1",
				name: "old-a",
				files: ["index.html"],
				size: 1024,
				createdAt: 1780000000000,
			},
			// 自定义空间
			{
				id: "s2",
				name: "blog-x",
				files: ["index.html"],
				size: 2048,
				createdAt: 1780000000001,
				cfSpaceId: "sp1",
			},
			// 显式 null → 默认空间
			{
				id: "s3",
				name: "old-b",
				files: ["index.html"],
				size: 4096,
				createdAt: 1780000000002,
				cfSpaceId: null,
			},
		],
		pending: 0,
		totalSize: 7168,
		totalLimit: 104857600,
	}));
	const { unmount } = await renderSharesTab();
	// 下拉出现，默认「全部分享」：3 条全显（平铺，无分组头）
	const filter = screen.getByTestId("share-space-filter") as HTMLSelectElement;
	expect(filter.value).toBe("all");
	expect(screen.getByTestId("share-item-s1")).toBeTruthy();
	expect(screen.getByTestId("share-item-s2")).toBeTruthy();
	expect(screen.getByTestId("share-item-s3")).toBeTruthy();
	// 切到「博客」：只显 s2
	fireEvent.change(filter, { target: { value: "sp1" } });
	expect(screen.queryByTestId("share-item-s1")).toBeNull();
	expect(screen.getByTestId("share-item-s2")).toBeTruthy();
	expect(screen.queryByTestId("share-item-s3")).toBeNull();
	// 切到默认空间：s1/s3（cfSpaceId 缺失与 null 都归默认）
	fireEvent.change(filter, { target: { value: "default" } });
	expect(screen.getByTestId("share-item-s1")).toBeTruthy();
	expect(screen.queryByTestId("share-item-s2")).toBeNull();
	expect(screen.getByTestId("share-item-s3")).toBeTruthy();
	unmount();

	// edgeone 渠道：无空间概念 → 无下拉，平铺全部
	getMock.mockImplementation(async () => ({
		share: { hasToken: true, channel: "edgeone" },
	}));
	await renderSharesTab();
	expect(screen.queryByTestId("share-space-filter")).toBeNull();
	expect(screen.getByTestId("share-item-s1")).toBeTruthy();
	expect(screen.getByTestId("share-item-s2")).toBeTruthy();
});

test("存储用量：totalLimit=0（云端无接口可查）时只显示已用量，不显示上限", async () => {
	shareListMock.mockImplementation(async () => ({
		items: [],
		pending: 0,
		totalSize: 428000,
		totalLimit: 0,
		workspaceDir: "/tmp/ws-test",
	}));
	await renderSharesTab();
	// 只显示已用量「存储 418 KB」，不出现「/」上限或「不限」
	expect(screen.getByText(/存储 418 KB/)).toBeTruthy();
	expect(screen.queryByText(/不限/)).toBeNull();
	expect(screen.queryByText(/5.0 GB|100 MB/)).toBeNull();
});

test("删除：点击 share-delete-<id> → shareDelete 被调 + 列表刷新", async () => {
	shareListMock.mockImplementation(async () => ({
		items: [
			{
				id: "s1",
				name: "proj-a",
				files: ["index.html"],
				size: 2048,
				createdAt: 1780000000000,
			},
		],
		pending: 0,
		totalSize: 2048,
		totalLimit: 104857600,
	}));
	await renderSharesTab();
	await screen.findByTestId("share-item-s1");
	// mount 时已调一次 shareList
	expect(shareListMock).toHaveBeenCalledTimes(1);
	fireEvent.click(screen.getByTestId("share-delete-s1"));
	await new Promise((r) => setTimeout(r, 10));
	expect(shareDeleteMock).toHaveBeenCalledWith("s1");
	// 删除后重新拉取列表
	expect(shareListMock).toHaveBeenCalledTimes(2);
});

test("复制链接：点击 share-copy-<id> → shareRefreshLink 被调 + copyToClipboard 收到 url", async () => {
	shareListMock.mockImplementation(async () => ({
		items: [
			{
				id: "s1",
				name: "proj-a",
				files: ["index.html"],
				size: 2048,
				createdAt: 1780000000000,
			},
		],
		pending: 0,
		totalSize: 2048,
		totalLimit: 104857600,
	}));
	shareRefreshLinkMock.mockImplementation(async () => ({
		url: "https://share.edgeone.app/s/xyz789",
		expiresAt: 1780010800000,
	}));
	await renderSharesTab();
	await screen.findByTestId("share-item-s1");
	fireEvent.click(screen.getByTestId("share-copy-s1"));
	await new Promise((r) => setTimeout(r, 10));
	expect(shareRefreshLinkMock).toHaveBeenCalledWith("s1");
	expect(copyMock).toHaveBeenCalledWith("https://share.edgeone.app/s/xyz789");
	// 复制成功 toast 提示
	const { useToastStore } = await import("../../store/toast");
	expect(
		useToastStore.getState().toasts.some((t) => t.message === "已复制"),
	).toBe(true);
});

test("立即部署：pending > 0 显示提示；点击 share-deploy → shareDeploy 被调", async () => {
	shareListMock.mockImplementation(async () => ({
		items: [],
		pending: 2,
		totalSize: 0,
		totalLimit: 104857600,
	}));
	await renderSharesTab();
	// pending 提示带插值计数
	const hint = await screen.findByTestId("share-pending");
	expect(hint.textContent).toContain("2");
	fireEvent.click(screen.getByTestId("share-deploy"));
	await new Promise((r) => setTimeout(r, 10));
	expect(shareDeployMock).toHaveBeenCalledTimes(1);
});

test("保存带 customDomain：输入域名点保存 → PUT body 含 customDomain", async () => {
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	fireEvent.change(screen.getByTestId("share-domain-input"), {
		target: { value: "share.example.com" },
	});
	fireEvent.click(screen.getByTestId("share-token-save"));
	await new Promise((r) => setTimeout(r, 10));
	expect(putMock).toHaveBeenCalledWith("/api/settings/share", {
		share: {
			token: "",
			channel: "edgeone",
			accountId: "",
			customDomain: "share.example.com",
		},
	});
});

test("tab 切换：默认分享设置，点「我的分享」切列表，互斥渲染", async () => {
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	// 默认分享设置 tab：token 输入框可见，管理区不可见
	expect(screen.getByTestId("share-token-input")).toBeTruthy();
	expect(screen.queryByTestId("share-manage")).toBeNull();
	// 切到我的分享
	fireEvent.click(screen.getByTestId("share-tab-shares"));
	await screen.findByTestId("share-manage");
	expect(screen.queryByTestId("share-token-input")).toBeNull();
	// 切回分享设置
	fireEvent.click(screen.getByTestId("share-tab-settings"));
	await screen.findByTestId("share-token-input");
	expect(screen.queryByTestId("share-manage")).toBeNull();
});

test("打开分享文件夹：点击文件夹 icon → showItemInFolder 收到 workspaceDir", async () => {
	const showMock = mock(async () => true);
	(window as any).waPiApp = { showItemInFolder: showMock };
	try {
		shareListMock.mockImplementation(async () => ({
			...emptyList,
			workspaceDir: "/tmp/ws-test",
		}));
		await renderSharesTab();
		fireEvent.click(screen.getByTestId("share-open-folder"));
		await new Promise((r) => setTimeout(r, 10));
		expect(showMock).toHaveBeenCalledWith("/tmp/ws-test");
	} finally {
		delete (window as any).waPiApp;
	}
});

test("立即部署中显示进度条（uploading 阶段显示百分比文案）", async () => {
	// shareDeploy 挂起保持 deploying 态；模拟 kernel SSE 推送的 uploading 进度
	shareDeployMock.mockImplementation(() => new Promise(() => {}));
	useShareProgressStore.setState({ phase: "uploading", percent: 30 });
	await renderSharesTab();
	fireEvent.click(screen.getByTestId("share-deploy"));
	await screen.findByTestId("share-deploy-progress");
	expect(screen.getByTestId("share-deploy-progress-text").textContent).toContain(
		"30%",
	);
	expect(screen.getByTestId("progress-bar-fill").style.width).toBe("30%");
});

test("打开分享文件夹兜底：无 Electron 能力时调 kernel shareOpenFolder", async () => {
	// 不设置 window.waPiApp（浏览器/dev 场景）
	delete (window as any).waPiApp;
	shareListMock.mockImplementation(async () => ({
		...emptyList,
		workspaceDir: "/tmp/ws-test",
	}));
	await renderSharesTab();
	fireEvent.click(screen.getByTestId("share-open-folder"));
	await new Promise((r) => setTimeout(r, 10));
	expect(shareOpenFolderMock).toHaveBeenCalledTimes(1);
});

test("清空分享二次确认：弹窗确认后才调 shareClear", async () => {
	shareListMock.mockImplementation(async () => ({
		...emptyList,
		items: [
			{
				id: "s1",
				name: "proj-a",
				files: ["index.html"],
				size: 2048,
				createdAt: 1780000000000,
			},
		],
		totalSize: 2048,
	}));
	await renderSharesTab();
	await screen.findByTestId("share-item-s1");
	// 点击清空 → 弹确认框，shareClear 未调
	fireEvent.click(screen.getByTestId("share-clear"));
	await screen.findByTestId("confirm-dialog");
	expect(shareClearMock).not.toHaveBeenCalled();
	// 取消 → 关闭弹窗不调
	fireEvent.click(screen.getByTestId("confirm-cancel"));
	await new Promise((r) => setTimeout(r, 10));
	expect(screen.queryByTestId("confirm-dialog")).toBeNull();
	expect(shareClearMock).not.toHaveBeenCalled();
	// 确认 → 调用并刷新
	fireEvent.click(screen.getByTestId("share-clear"));
	fireEvent.click(await screen.findByTestId("confirm-ok"));
	await new Promise((r) => setTimeout(r, 10));
	expect(shareClearMock).toHaveBeenCalledTimes(1);
});

test("我的分享：铅笔重命名 → 变 input → 回车保存调 shareRename", async () => {
	shareListMock.mockImplementation(async () => ({
		items: [
			{
				id: "s1",
				name: "proj-a",
				files: ["index.html"],
				size: 2048,
				createdAt: 1780000000000,
			},
		],
		pending: 0,
		totalSize: 2048,
		totalLimit: 104857600,
	}));
	shareRenameMock.mockImplementation(async () => ({
		id: "s1",
		name: "新名字",
		files: ["index.html"],
		size: 2048,
		createdAt: 1780000000000,
	}));
	const { unmount } = await renderSharesTab();
	await screen.findByTestId("share-item-s1");

	// 点击铅笔 → input 出现（预填旧名）
	fireEvent.click(screen.getByTestId("share-rename-s1"));
	const input = screen.getByTestId("share-rename-input-s1") as HTMLInputElement;
	expect(input.value).toBe("proj-a");

	// 改值 + 回车 → 调 shareRename
	fireEvent.change(input, { target: { value: "新名字" } });
	fireEvent.keyDown(input, { key: "Enter" });
	expect(shareRenameMock).toHaveBeenCalledWith("s1", "新名字");
	unmount();
});

test("切换渠道后 Token 需重新填写：已保存掩码态切渠道 → 清空并回到输入框", async () => {
	// mount 回填：已保存 token（edgeone）→ 掩码展示
	getMock.mockImplementation(async () => ({
		share: { hasToken: true, channel: "edgeone" },
	}));
	render(<ShareSection />);
	await screen.findByTestId("share-token-mask");
	// 切到 Cloudflare → 掩码消失，出现空输入框（旧渠道 token 不复用，需重新填写）
	fireEvent.click(screen.getByTestId("share-channel-cloudflare"));
	// 布尔包装：避免 bun 打印巨型 DOM 卡死（happy-dom 大对象 inspect 问题）
	expect(Boolean(screen.queryByTestId("share-token-mask"))).toBe(false);
	const input = screen.getByTestId("share-token-input") as HTMLInputElement;
	expect(input.value).toBe("");
});

test("切换渠道再切回：已保存的 token 掩码恢复，不清空已保存状态", async () => {
	// mount 回填：已保存 token（edgeone）→ 掩码展示
	getMock.mockImplementation(async () => ({
		share: { hasToken: true, channel: "edgeone" },
	}));
	render(<ShareSection />);
	await screen.findByTestId("share-token-mask");
	// 切到 Cloudflare → 需重新填写（输入框）
	fireEvent.click(screen.getByTestId("share-channel-cloudflare"));
	expect(Boolean(screen.queryByTestId("share-token-mask"))).toBe(false);
	expect(screen.getByTestId("share-token-input")).toBeTruthy();
	// 切回 EdgeOne → 恢复已保存掩码（不因切走被清空）
	fireEvent.click(screen.getByTestId("share-channel-edgeone"));
	expect(screen.getByTestId("share-token-mask")).toBeTruthy();
	expect(Boolean(screen.queryByTestId("share-token-input"))).toBe(false);
});

test("切换渠道清空已输入的 Token（编辑态）", async () => {
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	fireEvent.change(screen.getByTestId("share-token-input"), {
		target: { value: "edgeone-token-xyz" },
	});
	fireEvent.click(screen.getByTestId("share-channel-cloudflare"));
	const input = screen.getByTestId("share-token-input") as HTMLInputElement;
	expect(input.value).toBe("");
});

test("可切换到 Cloudflare 渠道，显示 token 与 Account ID 输入，保存时带 accountId", async () => {
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	// 渠道单选存在：edgeone（默认选中）与 cloudflare
	const edgeoneRadio = screen.getByTestId(
		"share-channel-edgeone",
	) as HTMLInputElement;
	const cfRadio = screen.getByTestId(
		"share-channel-cloudflare",
	) as HTMLInputElement;
	expect(edgeoneRadio.checked).toBe(true);
	expect(cfRadio.checked).toBe(false);
	// 默认 edgeone：无 Account ID 输入框
	expect(screen.queryByTestId("share-account-id-input")).toBeNull();
	// 切到 Cloudflare → 注册链接 + 提示文案（Account ID 不显示，自动获取）
	fireEvent.click(cfRadio);
	expect(screen.queryByTestId("share-account-id-input")).toBeNull();
	expect(screen.queryByTestId("share-account-help")).toBeNull();
	const cfLink = screen.getByTestId("share-cf-register-link");
	expect(cfLink.getAttribute("href")).toBe(
		"https://dash.cloudflare.com/sign-up",
	);
	expect(cfLink.textContent).toContain("注册 Cloudflare");
	expect(screen.getByText(/Cloudflare 分享链接永久公开/)).toBeTruthy();
	// 输入 token，保存 → PUT body 含 channel/token/customDomain（accountId 自动获取，不手动填）
	fireEvent.change(screen.getByTestId("share-token-input"), {
		target: { value: "cf-token-abc" },
	});
	fireEvent.click(screen.getByTestId("share-token-save"));
	await new Promise((r) => setTimeout(r, 10));
	expect(putMock).toHaveBeenCalledWith("/api/settings/share", {
		share: {
			channel: "cloudflare",
			token: "cf-token-abc",
			accountId: "",
			customDomain: "",
		},
	});
});

test("我的分享：有未部署变更时按钮下方提示需部署生效", async () => {
	shareListMock.mockImplementation(async () => ({
		items: [
			{
				id: "s1",
				name: "proj-a",
				files: ["index.html"],
				size: 2048,
				createdAt: 1780000000000,
			},
		],
		pending: 1,
		totalSize: 2048,
		totalLimit: 104857600,
	}));
	const { unmount } = await renderSharesTab();
	await screen.findByTestId("share-pending");
	// 按钮下方提示明确含「需部署生效」语义
	expect(screen.getByTestId("share-pending").textContent).toContain("未部署");
	unmount();
});

// ===== 分享空间管理区（仅 cloudflare 渠道显示）=====

const cfSpaces = [
	{
		id: "default",
		name: "默认空间",
		projectName: "wapi-shares",
		createdAt: 0,
		shareCount: 2,
	},
	{
		id: "sp1",
		name: "博客",
		projectName: "wapi-blog",
		createdAt: 1,
		shareCount: 0,
	},
];

test("分享空间管理区：CF 渠道显示（列表/新增/配额提示），默认空间不可删", async () => {
	getMock.mockImplementation(async (path: string) =>
		path === "/api/settings/share"
			? { share: { hasToken: true, channel: "cloudflare" } }
			: {},
	);
	shareSpacesFactoryMock.mockResolvedValue(cfSpaces);
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	fireEvent.click(screen.getByTestId("share-channel-cloudflare"));

	// 管理区出现：空间列表（名称/项目名/条数）+ 新增按钮 + 配额静态文案
	await screen.findByTestId("share-spaces");
	expect(screen.getByText("博客")).toBeTruthy();
	expect(screen.getByText("wapi-blog")).toBeTruthy();
	expect(screen.getByTestId("share-space-count-sp1").textContent).toContain("0");
	expect(screen.getByTestId("share-space-add")).toBeTruthy();
	expect(screen.getByTestId("share-spaces-quota").textContent).toContain("100");
	// 默认空间：无删除按钮（内置不可删）
	expect(screen.queryByTestId("share-space-delete-default")).toBeNull();
	// 空空间可删
	expect(
		(screen.getByTestId("share-space-delete-sp1") as HTMLButtonElement).disabled,
	).toBe(false);

	// EdgeOne 渠道下隐藏管理区
	fireEvent.click(screen.getByTestId("share-channel-edgeone"));
	await waitFor(() => expect(screen.queryByTestId("share-spaces")).toBeNull());
});

test("分享空间管理区：有分享的空间删除按钮置灰 + 提示", async () => {
	getMock.mockImplementation(async (path: string) =>
		path === "/api/settings/share"
			? { share: { hasToken: true, channel: "cloudflare" } }
			: {},
	);
	shareSpacesFactoryMock.mockResolvedValue([{ ...cfSpaces[1], shareCount: 3 }]);
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	fireEvent.click(screen.getByTestId("share-channel-cloudflare"));
	await screen.findByTestId("share-spaces");
	const delBtn = screen.getByTestId(
		"share-space-delete-sp1",
	) as HTMLButtonElement;
	expect(delBtn.disabled).toBe(true);
	expect(delBtn.title).toContain("清空");
	// 置灰时点击不触发删除
	fireEvent.click(delBtn);
	expect(shareDeleteSpaceFactoryMock).not.toHaveBeenCalled();
});

test("新增空间：弹窗填名称（项目名自动建议可改）→ 提交后刷新列表", async () => {
	getMock.mockImplementation(async (path: string) =>
		path === "/api/settings/share"
			? { share: { hasToken: true, channel: "cloudflare" } }
			: {},
	);
	shareSpacesFactoryMock.mockResolvedValue(cfSpaces);
	shareAddSpaceFactoryMock.mockResolvedValue({ space: { id: "sp2" } });
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	fireEvent.click(screen.getByTestId("share-channel-cloudflare"));
	await screen.findByTestId("share-spaces");

	fireEvent.click(screen.getByTestId("share-space-add"));
	await screen.findByTestId("share-space-modal");
	fireEvent.change(screen.getByTestId("share-space-name-input"), {
		target: { value: "博客" },
	});
	// 项目名自动建议 wapi-share-<短随机>，可改
	const projInput = screen.getByTestId(
		"share-space-project-input",
	) as HTMLInputElement;
	expect(projInput.value).toMatch(/^wapi-share-/);
	fireEvent.change(projInput, { target: { value: "wapi-blog" } });
	fireEvent.click(screen.getByTestId("share-space-submit"));
	await waitFor(() =>
		expect(shareAddSpaceFactoryMock).toHaveBeenCalledWith("博客", "wapi-blog"),
	);
	// 提交后刷新列表
	await waitFor(() => expect(shareSpacesFactoryMock).toHaveBeenCalledTimes(2));
});

test("删除空间：确认弹窗后调用删除，toast 展示「不删云端」提示", async () => {
	getMock.mockImplementation(async (path: string) =>
		path === "/api/settings/share"
			? { share: { hasToken: true, channel: "cloudflare" } }
			: {},
	);
	shareSpacesFactoryMock.mockResolvedValue(cfSpaces);
	shareDeleteSpaceFactoryMock.mockResolvedValue({
		notice:
			"空间已删除（云端 Pages 项目未受影响，可手动在 Cloudflare 控制台清理）",
	});
	render(<ShareSection />);
	await screen.findByTestId("share-section");
	fireEvent.click(screen.getByTestId("share-channel-cloudflare"));
	await screen.findByTestId("share-spaces");

	fireEvent.click(screen.getByTestId("share-space-delete-sp1"));
	await screen.findByTestId("confirm-dialog");
	fireEvent.click(screen.getByTestId("confirm-ok"));
	await waitFor(() =>
		expect(shareDeleteSpaceFactoryMock).toHaveBeenCalledWith("sp1"),
	);
});
