// GitGraphModal 组件测试：提交表格 + SVG 泳道 + 装饰 chip + 加载更多 + 空/错误态
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GitGraphModal } from "../src/components/git/GitGraphModal";
import type { GitCommitInfo } from "@wa-pi/shared";

const getMock = mock();
const postMock = mock();
mock.module("../src/api-client", () => ({
	api: {
		get: getMock,
		post: postMock,
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

/** 造一条提交；日期用本地时间构造，避免时区影响 MM/DD HH:mm 断言 */
function commit(
	hash: string,
	refs: GitCommitInfo["refs"] = [],
	parents: string[] = [],
): GitCommitInfo {
	return {
		hash,
		parents,
		refs,
		author: "co",
		date: new Date(2026, 8, 6, 10, 5).toISOString(),
		subject: `commit ${hash.slice(0, 4)}`,
	};
}

const C1 = commit("aaaaaaa1111111", [
	{ kind: "head", name: "HEAD" },
	{ kind: "branch", name: "main" },
	{ kind: "tag", name: "v0.3.12" },
	{ kind: "remote", name: "origin/main" },
]);
const C2 = commit("bbbbbbb2222222", [], ["aaaaaaa1111111"]);

beforeEach(() => {
	getMock.mockReset();
	getMock.mockImplementation((path: string) => {
		if (path.includes("/git/log")) return Promise.resolve({ commits: [C1, C2] });
		return Promise.resolve({});
	});
});

test("加载后渲染五列表格与提交行（短 hash/日期/作者/装饰 chip/SVG）", async () => {
	render(<GitGraphModal projectId="p1" onClose={() => {}} />);
	expect(screen.getByTestId("git-graph-modal")).toBeTruthy();
	await waitFor(() => screen.getByTestId("git-log-row-aaaaaaa"));
	// 表头五列
	for (const col of ["图", "描述", "日期", "作者", "提交"]) {
		expect(screen.getByText(col)).toBeTruthy();
	}
	// 首屏请求 limit=200
	expect(getMock).toHaveBeenCalledWith("/api/projects/p1/git/log?limit=200");
	// 两行都有 SVG 图列
	expect(screen.getAllByTestId("git-graph-svg").length).toBe(2);
	// 装饰 chip
	const row1 = screen.getByTestId("git-log-row-aaaaaaa");
	expect(row1.textContent).toContain("HEAD");
	expect(row1.textContent).toContain("main");
	expect(row1.textContent).toContain("v0.3.12");
	expect(row1.textContent).toContain("origin/main");
	expect(row1.textContent).toContain("commit aaaa");
	// 日期 MM/DD HH:mm + 短 hash 前 7 位
	expect(row1.textContent).toContain("09/06 10:05");
	expect(row1.textContent).toContain("aaaaaaa");
	expect(row1.textContent).not.toContain("aaaaaaa1");
	// 作者列
	expect(screen.getByTestId("git-log-row-bbbbbbb").textContent).toContain("co");
});

test("空提交列表显示空态", async () => {
	getMock.mockImplementation(() => Promise.resolve({ commits: [] }));
	render(<GitGraphModal projectId="p1" onClose={() => {}} />);
	await waitFor(() => screen.getByText("暂无提交记录"));
});

test("加载失败显示错误态", async () => {
	getMock.mockImplementation(() => Promise.reject(new Error("boom")));
	render(<GitGraphModal projectId="p1" onClose={() => {}} />);
	await waitFor(() => screen.getByText(/boom/));
});

test("返回满 200 条时显示「加载更多」，点击后以 limit=400 重拉", async () => {
	const many = Array.from({ length: 200 }, (_, i) =>
		commit(`h${String(i).padStart(6, "0")}xxxxxxx`),
	);
	getMock.mockImplementation(() => Promise.resolve({ commits: many }));
	render(<GitGraphModal projectId="p1" onClose={() => {}} />);
	await waitFor(() => screen.getByText("加载更多"));
	fireEvent.click(screen.getByText("加载更多"));
	await waitFor(() =>
		expect(getMock).toHaveBeenCalledWith(
			"/api/projects/p1/git/log?limit=400",
		),
	);
});

test("不足 200 条时不显示「加载更多」", async () => {
	render(<GitGraphModal projectId="p1" onClose={() => {}} />);
	await waitFor(() => screen.getByTestId("git-log-row-aaaaaaa"));
	expect(screen.queryByText("加载更多")).toBeNull();
});

test("刷新按钮重新拉取，关闭按钮触发 onClose", async () => {
	const onClose = mock();
	render(<GitGraphModal projectId="p1" onClose={onClose} />);
	await waitFor(() => screen.getByTestId("git-log-row-aaaaaaa"));
	const before = getMock.mock.calls.length;
	fireEvent.click(screen.getByTestId("git-graph-refresh"));
	await waitFor(() =>
		expect(getMock.mock.calls.length).toBeGreaterThan(before),
	);
	fireEvent.click(screen.getByTestId("git-graph-close"));
	expect(onClose).toHaveBeenCalledTimes(1);
});
