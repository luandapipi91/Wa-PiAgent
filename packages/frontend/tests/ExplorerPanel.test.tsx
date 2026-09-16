// ExplorerPanel 组件测试：目录展开/折叠、文件双击预览、右键菜单。
import { test, expect, beforeEach, afterEach } from "bun:test";
import type { ReactElement } from "react";
import {
	render,
	screen,
	fireEvent,
	waitFor,
	cleanup,
} from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { ExplorerPanel } from "../src/components/ExplorerPanel";
import { _setFsTransport } from "../src/fs-client";
import { makeFakeFsTransport } from "./fs-transport";
import { useToastStore } from "../src/store/toast";

// 虚拟化列表在 happy-dom 无布局：用 VirtuosoMockContext 提供视口测量值才渲染行
function renderExplorer(ui: ReactElement) {
	return render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 24 }}>
			{ui}
		</VirtuosoMockContext.Provider>,
	);
}

const fake = makeFakeFsTransport();

beforeEach(() => {
	_setFsTransport(fake.transport);
	useToastStore.setState({ toasts: [] });
	fake.calls.length = 0;
	fake.sent.length = 0;
	fake.responses.clear();
});
afterEach(() => cleanup());

// listDir 返回 DirEntry{name,isDir}；fs-transport 把 POST /api/fs/list-dir 映射为 fs:listDir
test("初始加载根目录，点击目录展开子项，再点折叠", async () => {
	fake.setResponse("fs:listDir", {
		entries: [
			{ name: "src", isDir: true },
			{ name: "readme.md", isDir: false },
		],
	});
	const { rerender } = renderExplorer(
		<ExplorerPanel workspaceDir="/work/demo" onOpenFile={() => {}} />,
	);

	// 根目录加载
	await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
	expect(screen.getByText("readme.md")).toBeTruthy();

	// 展开 src：第二次 listDir 返回子项
	fake.setResponse("fs:listDir", {
		entries: [{ name: "index.ts", isDir: false }],
	});
	fireEvent.click(screen.getByText("src"));
	await waitFor(() => expect(screen.getByText("index.ts")).toBeTruthy());

	// 再次点击 src 折叠（用 text "src" 定位节点）
	fireEvent.click(screen.getByText("src"));
	await waitFor(() => expect(screen.queryByText("index.ts")).toBeNull());
});

test("listDir 请求带 showHidden=true：隐藏文件/文件夹（.git/.env）不显示是 kernel 过滤导致，前端必须放行", async () => {
	fake.setResponse("fs:listDir", { entries: [{ name: "a.ts", isDir: false }] });
	renderExplorer(
		<ExplorerPanel workspaceDir="/work/demo" onOpenFile={() => {}} />,
	);
	await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());

	// 首次加载根目录的 list-dir 请求必须携带 showHidden: true
	const listCall = fake.calls.find((c) => c.type === "fs:listDir");
	expect(listCall).toBeTruthy();
	expect(listCall!.body).toEqual({ path: "/work/demo", showHidden: true });
});

test("双击文件触发 onOpenFile（绝对路径）", async () => {
	fake.setResponse("fs:listDir", { entries: [{ name: "a.ts", isDir: false }] });
	const ref = { opened: null as string | null };
	renderExplorer(
		<ExplorerPanel
			workspaceDir="/work/demo"
			onOpenFile={(p) => {
				ref.opened = p;
			}}
		/>,
	);

	await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
	fireEvent.doubleClick(screen.getByText("a.ts"));
	expect(ref.opened).toBe("/work/demo/a.ts");
});

test("右键文件弹出菜单，含复制路径项", async () => {
	fake.setResponse("fs:listDir", { entries: [{ name: "b.ts", isDir: false }] });
	renderExplorer(
		<ExplorerPanel workspaceDir="/work/demo" onOpenFile={() => {}} />,
	);

	const node = await waitFor(() => screen.getByText("b.ts"));
	fireEvent.contextMenu(node);
	await waitFor(() => expect(screen.getByText("复制路径")).toBeTruthy());
	// 菜单文案随平台变化（Windows=资源管理器、linux=文件管理器、mac=访达）
	expect(screen.getByText(/在(资源管理器|文件管理器|访达)中打开/)).toBeTruthy();
});

test("未设置 workspaceDir 显示占位", () => {
	renderExplorer(<ExplorerPanel workspaceDir="" onOpenFile={() => {}} />);
	expect(screen.getByText("未设置工作目录")).toBeTruthy();
});
