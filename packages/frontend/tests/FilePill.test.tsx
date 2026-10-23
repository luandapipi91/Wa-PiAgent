// FilePill 组件测试：形似文件路径的行内 code 渲染为胶囊，点击触发全局文件预览
// （状态写入 session store，由 App 根常驻的 FilePreviewModal 渲染）。
// 通过 fs-client 的传输 seam 注入伪 REST 响应。
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
	render,
	screen,
	fireEvent,
	waitFor,
	cleanup,
} from "@testing-library/react";
import {
	FilePill,
	resolveAbsolutePath,
} from "../src/components/blocks/FilePill";
import { FilePreviewModal } from "../src/components/blocks/FilePreviewModal";
import { _clearFsQueryCache, _setFsTransport } from "../src/fs-client";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";
import { useBrowserStore } from "../src/store/browser";
import { useToastStore } from "../src/store/toast";
import { makeFakeFsTransport } from "./fs-transport";

// FilePill 现在走批量探测（statFilesBatched → /api/fs/stat-batch），响应需按请求里的
// paths 动态生成：path 必须回显，否则客户端会把未回显的路径按「不存在」处理。
let statExists = true;
const fake = makeFakeFsTransport((evt) => {
	if (evt.type !== "fs:statBatch") return undefined;
	const paths = (evt as { paths?: string[] }).paths ?? [];
	return { results: paths.map((p) => ({ path: p, exists: statExists })) };
});

beforeEach(() => {
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "demo", cwd: "/work/demo" } as any],
		sessions: [{ id: "s1", projectId: "p1" } as any],
	});
	useSessionStore.setState({ filePreview: null });
	useToastStore.setState({ toasts: [] });
	statExists = true;
	_clearFsQueryCache();
	_setFsTransport(fake.transport);
	fake.calls.length = 0;
	fake.sent.length = 0;
	fake.responses.clear();
});

afterEach(() => cleanup());

test("渲染胶囊（basename + 行号），点击写入全局 store 并弹预览，readFile 解析到项目 cwd", async () => {
	statExists = true;
	fake.setResponse("fs:readFile", {
		content: btoa("file-content-123"),
		mimeType: "text/plain",
	});
	render(
		<>
			<FilePill rawText="src/index.ts:12" sessionId="s1" />
			<FilePreviewModal />
		</>,
	);

	// statFile 异步校验文件存在后显示胶囊
	await waitFor(() =>
		expect(screen.getByTestId("file-pill").textContent).toContain("index.ts"),
	);

	fireEvent.click(screen.getByTestId("file-pill"));
	// 预览状态提升到全局 session store（宿主组件卸载/折叠也不受影响）
	expect(useSessionStore.getState().filePreview).toEqual({
		path: "/work/demo/src/index.ts",
		sessionId: "s1",
	});
	await waitFor(() =>
		expect(screen.getByTestId("file-preview-modal").textContent).toContain(
			"file-content-123",
		),
	);
	expect(fake.sent[1]).toMatchObject({
		type: "fs:readFile",
		path: "/work/demo/src/index.ts",
	});
});

test("Windows 盘符绝对路径渲染胶囊，点击后预览解析为盘符路径", async () => {
	statExists = true;
	fake.setResponse("fs:readFile", {
		content: btoa("win-content"),
		mimeType: "text/plain",
	});
	render(
		<>
			<FilePill
				rawText="C:/Users/co/.pi/agent-dev/workdir/1787358024927/beautiful.md"
				sessionId="s1"
			/>
			<FilePreviewModal />
		</>,
	);

	await waitFor(() =>
		expect(screen.getByTestId("file-pill").textContent).toContain("beautiful.md"),
	);
	fireEvent.click(screen.getByTestId("file-pill"));
	// 盘符绝对路径原样作为预览路径，不被 cwd 拼接
	expect(useSessionStore.getState().filePreview?.path).toBe(
		"C:/Users/co/.pi/agent-dev/workdir/1787358024927/beautiful.md",
	);
	expect(fake.sent[1]).toMatchObject({
		type: "fs:readFile",
		path: "C:/Users/co/.pi/agent-dev/workdir/1787358024927/beautiful.md",
	});
});

test("resolveAbsolutePath Windows cwd 拼接相对路径时统一为正斜杠", () => {
	useProjectsStore.setState({
		projects: [{ id: "p2", name: "winproj", cwd: "C:\\work\\wa-pi" } as any],
		sessions: [{ id: "s2", projectId: "p2" } as any],
	});
	const result = resolveAbsolutePath("routes/fs.ts", "s2");
	expect(result).not.toMatch(/\\[^\\]+\//);
	expect(result).toBe("C:/work/wa-pi/routes/fs.ts");
});

test("statFile 返回不存在时回退为纯文本 code", async () => {
	statExists = false;
	render(<FilePill rawText="src/missing.ts" sessionId="s1" />);

	await waitFor(() => expect(screen.queryByTestId("file-pill")).toBeNull());
	expect(screen.getByText("src/missing.ts").tagName).toBe("CODE");
});

test("非路径文本回退为普通 code", () => {
	render(<FilePill rawText="hello" sessionId="s1" />);
	expect(screen.queryByTestId("file-pill")).toBeNull();
});

test("预览 Modal 由常驻 FilePreviewModal 渲染（宿主 FilePill 卸载后仍保持打开）", async () => {
	statExists = true;
	fake.setResponse("fs:readFile", {
		content: btoa("file-content-123"),
		mimeType: "text/plain",
	});
	const { unmount } = render(
		<>
			<FilePill rawText="src/index.ts:12" sessionId="s1" />
			<FilePreviewModal />
		</>,
	);
	await waitFor(() =>
		expect(screen.getByTestId("file-pill").textContent).toContain("index.ts"),
	);
	fireEvent.click(screen.getByTestId("file-pill"));
	await waitFor(() =>
		expect(screen.getByTestId("file-preview-modal").textContent).toContain(
			"file-content-123",
		),
	);
	// 模拟宿主（FilePill 所在消息行/委派卡）随流式结束/折叠卸载
	unmount();
	// 预览窗由常驻 FilePreviewModal 渲染，重新挂载后应仍在（store 状态未丢失）
	render(<FilePreviewModal />);
	await waitFor(() =>
		expect(screen.getByTestId("file-preview-modal").textContent).toContain(
			"file-content-123",
		),
	);
});

test("用户手动关闭（ESC）后预览消失且 store 清空", async () => {
	statExists = true;
	fake.setResponse("fs:readFile", {
		content: btoa("file-content-123"),
		mimeType: "text/plain",
	});
	render(
		<>
			<FilePill rawText="src/index.ts:12" sessionId="s1" />
			<FilePreviewModal />
		</>,
	);
	await waitFor(() =>
		expect(screen.getByTestId("file-pill").textContent).toContain("index.ts"),
	);
	fireEvent.click(screen.getByTestId("file-pill"));
	await waitFor(() =>
		expect(screen.getByTestId("file-preview-modal")).toBeTruthy(),
	);
	fireEvent.keyDown(window, { key: "Escape" });
	await waitFor(() =>
		expect(screen.queryByTestId("file-preview-modal")).toBeNull(),
	);
	expect(useSessionStore.getState().filePreview).toBeNull();
});

test("html 文件点击 → 打开浏览器预览（browser store），不走文件预览", async () => {
	statExists = true;
	fake.setResponse("fs:readFile", {
		content: btoa("<html></html>"),
		mimeType: "text/html",
	});
	useBrowserStore.setState({ open: false, path: null, sessionId: null });
	render(<FilePill rawText="dist/index.html" sessionId="s1" />);
	await waitFor(() =>
		expect(screen.getByTestId("file-pill").textContent).toContain("index.html"),
	);
	fireEvent.click(screen.getByTestId("file-pill"));
	// html → 浏览器预览（BrowserPanel 由 browser store 驱动）
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useBrowserStore.getState().path).toBe("/work/demo/dist/index.html");
	expect(useSessionStore.getState().filePreview).toBeNull();
});

test("图片扩展名芯片点击 → 打开媒体画廊（mediaPreview），不走文件预览", async () => {
	statExists = true;
	useSessionStore.setState({ mediaPreview: null });
	render(<FilePill rawText="out/logo-blue.png" sessionId="s1" />);
	await waitFor(() =>
		expect(screen.getByTestId("file-pill").textContent).toContain(
			"logo-blue.png",
		),
	);
	fireEvent.click(screen.getByTestId("file-pill"));
	// 无 mediaItems 时以单媒体清单打开
	expect(useSessionStore.getState().mediaPreview).toMatchObject({
		items: [{ src: "out/logo-blue.png", kind: "image", name: "logo-blue.png" }],
		index: 0,
		sessionId: "s1",
	});
	expect(useSessionStore.getState().filePreview).toBeNull();
});

test("视频芯片点击 → 按传入的 mediaItems 清单定位画廊起点（绝对路径口径匹配）", async () => {
	statExists = true;
	useSessionStore.setState({ mediaPreview: null });
	const items = [
		{ src: "out/a.png", kind: "image" as const, name: "a.png" },
		{ src: "out/clip.mp4", kind: "video" as const, name: "clip.mp4" },
	];
	render(<FilePill rawText="out/clip.mp4" sessionId="s1" mediaItems={items} />);
	await waitFor(() =>
		expect(screen.getByTestId("file-pill").textContent).toContain("clip.mp4"),
	);
	fireEvent.click(screen.getByTestId("file-pill"));
	expect(useSessionStore.getState().mediaPreview).toMatchObject({
		items,
		index: 1,
		sessionId: "s1",
	});
});

test("非媒体扩展名芯片仍走文件预览（行为不变）", async () => {
	statExists = true;
	useSessionStore.setState({ mediaPreview: null });
	render(<FilePill rawText="src/index.ts:3" sessionId="s1" />);
	await waitFor(() =>
		expect(screen.getByTestId("file-pill").textContent).toContain("index.ts"),
	);
	fireEvent.click(screen.getByTestId("file-pill"));
	expect(useSessionStore.getState().filePreview?.path).toBe(
		"/work/demo/src/index.ts",
	);
	expect(useSessionStore.getState().mediaPreview).toBeNull();
});

// 回归（2026-09-16 卡顿定位）：消息里每个路径 chip 原本各发一次 /api/fs/stat——
// 一条消息几十个路径就是几十个并发请求。改为同一 tick 内合并成一个 stat-batch 请求。
test("同一 tick 挂载的多个 chip 合并为一个 stat-batch 请求", async () => {
	statExists = true;
	render(
		<>
			<FilePill rawText="src/a.ts" sessionId="s1" />
			<FilePill rawText="src/b.ts" sessionId="s1" />
			<FilePill rawText="src/c.ts" sessionId="s1" />
		</>,
	);
	await waitFor(() => expect(screen.getAllByTestId("file-pill").length).toBe(3));
	const batchCalls = fake.calls.filter((c) => c.path === "/api/fs/stat-batch");
	expect(batchCalls.length).toBe(1);
	// 单路径接口不再被调用
	expect(fake.calls.filter((c) => c.path === "/api/fs/stat").length).toBe(0);
	const body = batchCalls[0].body as { paths: string[] };
	expect(body.paths.length).toBe(3);
});

test("resolveAbsolutePath：默认工作区会话的相对路径拼 workdir/<createdAt> 会话子目录（画廊缩略图破图根因）", () => {
	useProjectsStore.setState({
		projects: [
			{ id: "__system__", name: "默认工作区", cwd: "/Users/co/.pi/agent/workdir", createdAt: 0 },
		],
		sessions: [
			{
				id: "s-sys-1",
				projectId: "__system__",
				primaryAgent: "dev",
				title: "t",
				createdAt: 1789872144129,
				lastActivity: 0,
				piSessionFile: "",
			},
		],
	});
	// agent 回复里的相对路径 image.png 实际在会话子目录 workdir/<createdAt>/ 下，
	// 拼项目 cwd（父目录）会指向不存在的文件 → /file 404 → 画廊缩略图破图
	expect(resolveAbsolutePath("image.png", "s-sys-1")).toBe(
		"/Users/co/.pi/agent/workdir/1789872144129/image.png",
	);
});

test("resolveAbsolutePath：普通项目会话仍拼项目 cwd（不回归）", () => {
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "WaPi", cwd: "/work/wa-pi", createdAt: 0 }],
		sessions: [
			{
				id: "s-p1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "t",
				createdAt: 111,
				lastActivity: 0,
				piSessionFile: "",
			},
		],
	});
	expect(resolveAbsolutePath("out/logo.png", "s-p1")).toBe("/work/wa-pi/out/logo.png");
});
