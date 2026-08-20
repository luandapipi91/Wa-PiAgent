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
import { _setFsTransport } from "../src/fs-client";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";
import { useBrowserStore } from "../src/store/browser";
import { useToastStore } from "../src/store/toast";
import { makeFakeFsTransport } from "./fs-transport";

const fake = makeFakeFsTransport();

beforeEach(() => {
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "demo", cwd: "/work/demo" } as any],
		sessions: [{ id: "s1", projectId: "p1" } as any],
	});
	useSessionStore.setState({ filePreview: null });
	useToastStore.setState({ toasts: [] });
	_setFsTransport(fake.transport);
	fake.calls.length = 0;
	fake.sent.length = 0;
	fake.responses.clear();
});

afterEach(() => cleanup());

test("渲染胶囊（basename + 行号），点击写入全局 store 并弹预览，readFile 解析到项目 cwd", async () => {
	fake.setResponse("fs:stat", { exists: true });
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
	fake.setResponse("fs:stat", { exists: false });
	render(<FilePill rawText="src/missing.ts" sessionId="s1" />);

	await waitFor(() => expect(screen.queryByTestId("file-pill")).toBeNull());
	expect(screen.getByText("src/missing.ts").tagName).toBe("CODE");
});

test("非路径文本回退为普通 code", () => {
	render(<FilePill rawText="hello" sessionId="s1" />);
	expect(screen.queryByTestId("file-pill")).toBeNull();
});

test("预览 Modal 由常驻 FilePreviewModal 渲染（宿主 FilePill 卸载后仍保持打开）", async () => {
	fake.setResponse("fs:stat", { exists: true });
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
	fake.setResponse("fs:stat", { exists: true });
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
	fake.setResponse("fs:stat", { exists: true });
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
