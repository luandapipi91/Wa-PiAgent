// 预览自动刷新契约测试（bun:test）：
// file_changes 事件（任务完成时 bridge 上报的本轮修改文件清单）命中「当前会话正在预览的
// 文件」时递增 refreshToken——BrowserPanel 以它作 iframe key，key 变化即重挂 → 重拉磁盘
// 最新内容（kernel 预览响应 no-store，重挂等价刷新）。
// 判定语义：只看「面板当前显示的预览」（open/path/sessionId 顶层状态）。
// 未显示会话的预览记忆（bySession）不触发刷新——切回时 iframe 挂载天然加载最新内容。
import { beforeEach, expect, test } from "bun:test";
import { useBrowserStore } from "../browser";

beforeEach(() => {
	// 归零：清预览状态与刷新令牌（actions 保留）
	useBrowserStore.setState({
		open: false,
		path: null,
		sessionId: null,
		bySession: {},
		refreshToken: 0,
	});
});

test("bumpRefresh：递增刷新令牌（手动刷新按钮同源）", () => {
	expect(useBrowserStore.getState().refreshToken).toBe(0);
	useBrowserStore.getState().bumpRefresh();
	expect(useBrowserStore.getState().refreshToken).toBe(1);
	useBrowserStore.getState().bumpRefresh();
	expect(useBrowserStore.getState().refreshToken).toBe(2);
});

test("命中：当前会话预览打开且预览文件在本轮修改清单中 → 递增", () => {
	useBrowserStore.setState({
		open: true,
		path: "/tmp/proj/index.html",
		sessionId: "s1",
	});
	// 真实事件结构：files 是 FileChangeSnapshot 对象数组（非字符串数组）
	useBrowserStore.getState().maybeRefreshForFileChanges("s1", [
		{ path: "/tmp/proj/app.js", before: "a", after: "b" },
		{ path: "/tmp/proj/index.html", before: "<old>", after: "<new>" },
	]);
	expect(useBrowserStore.getState().refreshToken).toBe(1);
});

test("预览未打开（open=false）→ 不刷新（即使 bySession 里残留打开记忆）", () => {
	useBrowserStore.setState({
		open: false,
		path: null,
		sessionId: "s1",
		bySession: {
			s1: { open: true, path: "/tmp/proj/index.html", minimized: false },
		},
	});
	useBrowserStore
		.getState()
		.maybeRefreshForFileChanges("s1", [
			{ path: "/tmp/proj/index.html", before: "x", after: "y" },
		]);
	expect(useBrowserStore.getState().refreshToken).toBe(0);
});

test("会话不符：事件属于其他会话 → 不刷新", () => {
	useBrowserStore.setState({
		open: true,
		path: "/tmp/proj/index.html",
		sessionId: "s1",
	});
	useBrowserStore
		.getState()
		.maybeRefreshForFileChanges("s2", [
			{ path: "/tmp/proj/index.html", before: "x", after: "y" },
		]);
	expect(useBrowserStore.getState().refreshToken).toBe(0);
});

test("路径不符：修改清单里没有预览文件 → 不刷新", () => {
	useBrowserStore.setState({
		open: true,
		path: "/tmp/proj/index.html",
		sessionId: "s1",
	});
	useBrowserStore
		.getState()
		.maybeRefreshForFileChanges("s1", [
			{ path: "/tmp/proj/style.css", before: null, after: "x" },
		]);
	expect(useBrowserStore.getState().refreshToken).toBe(0);
});

// ── 嵌套子页刷新：预览 A.html 内 <iframe src="./B.html"> 引用的 B.html 被修改 ——
// 外层 A.html 本身没变，但渲染内容已过时，也应刷新。为避免解析 iframe 引用树
//（需 kernel 新接口），命中范围放宽为「预览文件同目录（含子目录）的本地 html 文件」：
// 刷新是幂等的（重挂重拉磁盘最新），多刷无害；换取零 kernel 改动。
test("嵌套子页：同目录其他 html 被修改 → 刷新", () => {
	useBrowserStore.setState({
		open: true,
		path: "/tmp/proj/index.html",
		sessionId: "s1",
	});
	useBrowserStore
		.getState()
		.maybeRefreshForFileChanges("s1", [
			{ path: "/tmp/proj/inner.html", before: "a", after: "b" },
		]);
	expect(useBrowserStore.getState().refreshToken).toBe(1);
});

test("嵌套子页：子目录 html 被修改 → 刷新", () => {
	useBrowserStore.setState({
		open: true,
		path: "/tmp/proj/pages/index.html",
		sessionId: "s1",
	});
	useBrowserStore
		.getState()
		.maybeRefreshForFileChanges("s1", [
			{ path: "/tmp/proj/pages/sub/B.html", before: "a", after: "b" },
		]);
	expect(useBrowserStore.getState().refreshToken).toBe(1);
});

test("非同目录（兄弟目录/其他位置）html 不刷新；同目录非 html（css/js）不刷新", () => {
	useBrowserStore.setState({
		open: true,
		path: "/tmp/proj/pages/index.html",
		sessionId: "s1",
	});
	useBrowserStore.getState().maybeRefreshForFileChanges("s1", [
		{ path: "/tmp/proj/other/B.html", before: "a", after: "b" }, // 兄弟目录
		{ path: "/tmp/proj/pages/style.css", before: "a", after: "b" }, // 同目录非 html
	]);
	expect(useBrowserStore.getState().refreshToken).toBe(0);
});

test("目录前缀撞字符串前缀不误命中（/proj/pages/ 不匹配 /proj/pages-extra/ 改动）", () => {
	useBrowserStore.setState({
		open: true,
		path: "/tmp/proj/pages/index.html",
		sessionId: "s1",
	});
	useBrowserStore
		.getState()
		.maybeRefreshForFileChanges("s1", [
			{ path: "/tmp/proj/pages-extra/B.html", before: "a", after: "b" },
		]);
	expect(useBrowserStore.getState().refreshToken).toBe(0);
});

test("空预览（path=null）→ 不刷新", () => {
	useBrowserStore.setState({ open: true, path: null, sessionId: "s1" });
	useBrowserStore
		.getState()
		.maybeRefreshForFileChanges("s1", [
			{ path: "x.html", before: null, after: null },
		]);
	expect(useBrowserStore.getState().refreshToken).toBe(0);
});

test("空清单 / 无会话 id → 不刷新", () => {
	useBrowserStore.setState({
		open: true,
		path: "/tmp/proj/index.html",
		sessionId: "s1",
	});
	useBrowserStore.getState().maybeRefreshForFileChanges("s1", []);
	useBrowserStore
		.getState()
		.maybeRefreshForFileChanges(null, [
			{ path: "/tmp/proj/index.html", before: "x", after: "y" },
		]);
	expect(useBrowserStore.getState().refreshToken).toBe(0);
});
