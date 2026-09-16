import { describe, expect, test } from "bun:test";
import {
	isValidBranchName,
	layoutGitLanes,
	parseDecorations,
	parseGitLog,
	parsePullOutput,
	type GitCommitInfo,
} from "../src/git";

const SEP = "\x1f";

function logLine(
	hash: string,
	parents: string,
	decorations: string,
	author = "co",
	date = "2026-09-06T09:15:00+08:00",
	subject = "提交说明",
): string {
	return [hash, parents, decorations, author, date, subject].join(SEP);
}

describe("parseGitLog", () => {
	test("解析线性历史", () => {
		const raw = [
			logLine("aaa111", "bbb222", "HEAD -> master, origin/master"),
			logLine("bbb222", "ccc333", ""),
			logLine("ccc333", "", "", "co", "2026-09-05T20:00:00+08:00", "首个提交"),
		].join("\n");
		const commits = parseGitLog(raw);
		expect(commits).toHaveLength(3);
		expect(commits[0]).toMatchObject({
			hash: "aaa111",
			parents: ["bbb222"],
			author: "co",
			subject: "提交说明",
		});
		expect(commits[0].refs).toEqual([
			{ kind: "head", name: "HEAD" },
			{ kind: "branch", name: "master" },
			{ kind: "remote", name: "origin/master" },
		]);
		expect(commits[2].parents).toEqual([]);
	});

	test("merge 提交解析出多个 parent", () => {
		const commits = parseGitLog(logLine("m12345", "p1111 p2222", ""));
		expect(commits[0].parents).toEqual(["p1111", "p2222"]);
	});

	test("tag 装饰解析", () => {
		const commits = parseGitLog(
			logLine("t12345", "", "HEAD -> master, tag: v0.3.12, tag: v0.3.11"),
		);
		expect(commits[0].refs).toEqual([
			{ kind: "head", name: "HEAD" },
			{ kind: "branch", name: "master" },
			{ kind: "tag", name: "v0.3.12" },
			{ kind: "tag", name: "v0.3.11" },
		]);
	});

	test("空输入与空行容错", () => {
		expect(parseGitLog("")).toEqual([]);
		expect(parseGitLog("\n\n")).toEqual([]);
	});
});

describe("parseDecorations", () => {
	test("detached HEAD", () => {
		expect(parseDecorations("HEAD")).toEqual([{ kind: "head", name: "HEAD" }]);
	});
	test("空串", () => {
		expect(parseDecorations("")).toEqual([]);
	});
});

describe("parsePullOutput", () => {
	test("fast-forward 统计", () => {
		const out = parsePullOutput(
			"Updating 6108e099..391de637\nFast-forward\n src/a.ts | 10 +++\n 17 files changed, 925 insertions(+), 3 deletions(-)\n",
			"",
		);
		expect(out).toEqual({
			mode: "fast-forward",
			alreadyUpToDate: false,
			filesChanged: 17,
			insertions: 925,
			deletions: 3,
		});
	});

	test("已是最新", () => {
		const out = parsePullOutput("Already up to date.\n", "");
		expect(out.mode).toBe("none");
		expect(out.alreadyUpToDate).toBe(true);
		expect(out.filesChanged).toBe(0);
	});

	test("merge 提交合并", () => {
		const out = parsePullOutput(
			"Merge made by the 'ort' strategy.\n 2 files changed, 5 insertions(+)\n",
			"",
		);
		expect(out.mode).toBe("merge");
		expect(out.filesChanged).toBe(2);
		expect(out.insertions).toBe(5);
		expect(out.deletions).toBe(0);
	});
});

describe("isValidBranchName", () => {
	test("合法名", () => {
		for (const n of [
			"master",
			"feature/git-branch-switcher",
			"fix_123",
			"perf/streaming-render.v2",
		]) {
			expect(isValidBranchName(n)).toBe(true);
		}
	});
	test("非法名", () => {
		for (const n of [
			"",
			"  ",
			"has space",
			"-lead",
			"/lead",
			"trail/",
			"trail.",
			"a..b",
			"a@{b}",
			"a//b",
			".hidden",
			"a.lock",
			"what?",
			"a:b",
			"a*b",
			"a[b",
			"~tilde",
			"^caret",
			"@",
		]) {
			expect(isValidBranchName(n)).toBe(false);
		}
	});
});

describe("layoutGitLanes", () => {
	function commit(hash: string, parents: string[] = []): GitCommitInfo {
		return { hash, parents, refs: [], author: "co", date: "", subject: "" };
	}

	test("线性历史：全部在 lane 0，竖线贯穿", () => {
		const rows = layoutGitLanes([
			commit("c3", ["c2"]),
			commit("c2", ["c1"]),
			commit("c1", []),
		]);
		expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
		expect(rows[0].verticals).toEqual([{ fromLane: 0, toLane: 0, color: rows[0].color }]);
		// 最后一个提交无 parent，泳道终结
		expect(rows[2].laneCount).toBe(0);
		expect(rows[2].verticals).toEqual([]);
	});

	test("功能分支合入：merge 提交开出新泳道并在合入点回收", () => {
		// m 是 merge 提交：parents [main1, feat1]；feat1 → main0；main1 → main0
		const rows = layoutGitLanes([
			commit("m", ["main1", "feat1"]),
			commit("feat1", ["main0"]),
			commit("main1", ["main0"]),
			commit("main0", []),
		]);
		// m 在 lane 0；feat1 开新 lane 1
		expect(rows[0].lane).toBe(0);
		expect(rows[0].curves).toContainEqual({ fromLane: 0, toLane: 1, color: rows[1].color });
		// feat1 在 lane 1，其 parent main0 暂无泳道期望 → lane 1 暂时延续
		expect(rows[1].lane).toBe(1);
		// main1 在 lane 0，其 parent main0 已被 lane 1 期望 → 最左获胜，lane 1 并入 lane 0
		expect(rows[2].lane).toBe(0);
		expect(rows[2].curves).toContainEqual({ fromLane: 1, toLane: 0, color: rows[1].color });
		// main0 在 lane 0，无 parent → 全部回收
		expect(rows[3].lane).toBe(0);
		expect(rows[3].laneCount).toBe(0);
	});

	test("并行双分支：两条泳道颜色不同", () => {
		const rows = layoutGitLanes([
			commit("m", ["a1", "b1"]),
			commit("b1", ["base"]),
			commit("a1", ["base"]),
			commit("base", []),
		]);
		expect(rows[1].lane).not.toBe(rows[2].lane);
		expect(rows[1].color).not.toBe(rows[2].color);
	});

	test("空输入", () => {
		expect(layoutGitLanes([])).toEqual([]);
	});
});
