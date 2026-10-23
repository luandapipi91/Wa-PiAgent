// 文件树虚拟滚动 + 轮询按需更新 测试。
// 卡顿根因：flatList 全量渲染真实 DOM + 每 5s 轮询全量重建对象并 setFlatList 整表替换，
// 大目录（node_modules 数千条目）下常驻数千 DOM 节点 + 每轮全量 reconcile。
// 修复契约：
// 1. Virtuoso 虚拟化：数千节点只渲染视口内几十行 DOM；
// 2. 滚动容器由 Virtuoso 接管（data-virtuoso-scroller）；
// 3. 虚拟化下展开/选中交互不回退；
// 4. isSameTree 值比较：内容无变化 → true（配合 setFlatList 保留旧引用跳过重渲染）。
import { test, expect, afterEach } from "bun:test";
import {
	render,
	screen,
	waitFor,
	fireEvent,
	cleanup,
} from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { _setFsTransport } from "../src/fs-client";
import {
	ExplorerPanel,
	isSameTree,
	type FlatNode,
} from "../src/components/ExplorerPanel";

// 虚拟化列表在 happy-dom 无布局：必须用 VirtuosoMockContext 提供视口/行高测量值才渲染行
function renderExplorer(ui: React.ReactNode) {
	return render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 24 }}>
			{ui}
		</VirtuosoMockContext.Provider>,
	);
}

function mockListDirByPath(
	handler: (dirPath: string) => Array<{ name: string; isDir: boolean }>,
) {
	_setFsTransport({
		get: async () => ({}),
		post: async (_path: string, body?: unknown) => {
			if (_path === "/api/fs/list-dir") {
				const dir = (body as { path?: string })?.path ?? "";
				return { entries: handler(dir) };
			}
			return {};
		},
		del: async () => ({}),
	});
}

afterEach(() => {
	_setFsTransport(null);
	cleanup();
});

test("3000 个文件只渲染视口内的少量 DOM 行（虚拟化生效）", async () => {
	const entries = Array.from({ length: 3000 }, (_, i) => ({
		name: `file-${String(i).padStart(4, "0")}.ts`,
		isDir: false,
	}));
	mockListDirByPath(() => entries);
	const { container } = renderExplorer(
		<ExplorerPanel workspaceDir="/proj" onOpenFile={() => {}} />,
	);
	await waitFor(() => expect(screen.getByText("file-0000.ts")).toBeTruthy());
	const rows = container.querySelectorAll(".ep-node");
	expect(rows.length).toBeGreaterThan(0);
	// 600px 视口 / 24px 行高 ≈ 25 行 + overscan；绝不该等于 3000
	expect(rows.length).toBeLessThan(100);
});

test("滚动容器由 Virtuoso 接管（data-virtuoso-scroller 标记）", async () => {
	mockListDirByPath(() => [{ name: "a.ts", isDir: false }]);
	const { container } = renderExplorer(
		<ExplorerPanel workspaceDir="/proj" onOpenFile={() => {}} />,
	);
	await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
	expect(
		container.querySelector('[data-virtuoso-scroller="true"]'),
	).toBeTruthy();
});

test("虚拟化下点击目录展开仍渲染子节点、再点折叠消失", async () => {
	let expanded = false;
	mockListDirByPath((dir) => {
		if (dir === "/proj") return [{ name: "src", isDir: true }];
		if (dir === "/proj/src") {
			expanded = true;
			return [{ name: "index.ts", isDir: false }];
		}
		return [];
	});
	renderExplorer(<ExplorerPanel workspaceDir="/proj" onOpenFile={() => {}} />);
	await waitFor(() => expect(screen.getByText("src")).toBeTruthy());
	fireEvent.click(screen.getByText("src"));
	await waitFor(() => expect(screen.getByText("index.ts")).toBeTruthy());
	expect(expanded).toBe(true);
	// 折叠：子节点从 DOM 移除
	fireEvent.click(screen.getByText("src"));
	await waitFor(() => expect(screen.queryByText("index.ts")).toBeNull());
});

test("虚拟化下单选/多选 data-selected 正常", async () => {
	mockListDirByPath(() => [
		{ name: "a.ts", isDir: false },
		{ name: "b.ts", isDir: false },
	]);
	const { container } = renderExplorer(
		<ExplorerPanel workspaceDir="/proj" onOpenFile={() => {}} />,
	);
	await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
	const rowOf = (name: string) =>
		screen.getByText(name).closest(".ep-node") as HTMLElement;
	fireEvent.click(rowOf("a.ts"));
	expect(rowOf("a.ts").dataset.selected).toBe("true");
	fireEvent.click(rowOf("b.ts"), { metaKey: true });
	expect(container.querySelectorAll('[data-selected="true"]').length).toBe(2);
});

test("isSameTree：逐位值比较，内容相同 true、任一渲染字段差异 false", () => {
	const mk = (over: Partial<FlatNode> = {}): FlatNode => ({
		key: "/proj/a.ts",
		entry: { name: "a.ts", path: "/proj/a.ts", isDir: false },
		depth: 0,
		expanded: false,
		hasChildren: null,
		...over,
	});
	// 同内容不同对象引用 → true（轮询重建对象后值相等的场景）
	expect(isSameTree([mk()], [mk()])).toBe(true);
	// 空数组相等
	expect(isSameTree([], [])).toBe(true);
	// 长度不同
	expect(isSameTree([], [mk()])).toBe(false);
	// 名称变化（文件重命名/新增）
	expect(
		isSameTree(
			[mk()],
			[
				mk({
					key: "/proj/b.ts",
					entry: { name: "b.ts", path: "/proj/b.ts", isDir: false },
				}),
			],
		),
	).toBe(false);
	// isDir 变化
	expect(
		isSameTree(
			[mk()],
			[mk({ entry: { name: "a.ts", path: "/proj/a.ts", isDir: true } })],
		),
	).toBe(false);
	// 展开态变化
	expect(isSameTree([mk()], [mk({ expanded: true })])).toBe(false);
	// hasChildren 变化
	expect(isSameTree([mk()], [mk({ hasChildren: true })])).toBe(false);
});
