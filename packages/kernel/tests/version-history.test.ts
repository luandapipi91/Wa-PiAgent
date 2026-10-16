import { test, expect, beforeEach } from "bun:test";
import {
	VERSION_HISTORY_URL,
	__resetVersionHistoryCacheForTest,
	getRemoteVersionHistory,
	parseVersionHistory,
} from "../src/version-history";

const validPayload = [
	{ version: "0.6.10", date: "2026-09-24", sections: { 修复: ["a"] } },
	{ version: "0.6.9", date: "2026-09-23", sections: { 优化: ["b"] } },
];

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => __resetVersionHistoryCacheForTest());

test("线上地址与发版脚本上传 key 一致", () => {
	expect(VERSION_HISTORY_URL).toBe(
		"https://oss.wapiagent.top/releases/version-history.json",
	);
});

test("parseVersionHistory：丢弃结构非法的条目", () => {
	const parsed = parseVersionHistory([
		{ version: "0.6.10", date: "2026-09-24", sections: { 修复: ["a"] } },
		{ version: 1, date: "x", sections: {} },
		{ version: "0.6.8", date: "2026-09-23", sections: { 修复: ["c", 2] } },
		null,
	]);
	expect(parsed.map((e) => e.version)).toEqual(["0.6.10", "0.6.8"]);
});

test("拉取成功返回条目，并命中缓存（第二次不再发请求）", async () => {
	let calls = 0;
	const fetchImpl = (async () => {
		calls += 1;
		return jsonResponse(validPayload);
	}) as unknown as typeof fetch;
	const first = await getRemoteVersionHistory({ fetchImpl });
	expect(first.map((e) => e.version)).toEqual(["0.6.10", "0.6.9"]);
	const second = await getRemoteVersionHistory({ fetchImpl });
	expect(second.length).toBe(2);
	expect(calls).toBe(1);
});

test("TTL 过期后重新拉取", async () => {
	let calls = 0;
	const fetchImpl = (async () => {
		calls += 1;
		return jsonResponse(validPayload);
	}) as unknown as typeof fetch;
	let now = 1_000_000;
	await getRemoteVersionHistory({ fetchImpl, now: () => now });
	now += 7 * 60 * 60 * 1000;
	await getRemoteVersionHistory({ fetchImpl, now: () => now });
	expect(calls).toBe(2);
});

test("HTTP 失败不抛错：无缓存返回空数组", async () => {
	const fetchImpl = (async () =>
		new Response("boom", { status: 500 })) as unknown as typeof fetch;
	expect(await getRemoteVersionHistory({ fetchImpl })).toEqual([]);
});

test("网络异常不抛错，返回旧缓存", async () => {
	let ok = true;
	const fetchImpl = (async () => {
		if (!ok) throw new Error("network down");
		return jsonResponse(validPayload);
	}) as unknown as typeof fetch;
	let now = 1_000_000;
	await getRemoteVersionHistory({ fetchImpl, now: () => now });
	ok = false;
	now += 7 * 60 * 60 * 1000;
	const entries = await getRemoteVersionHistory({ fetchImpl, now: () => now });
	expect(entries.map((e) => e.version)).toEqual(["0.6.10", "0.6.9"]);
});

test("空数组/结构非法响应视为失败", async () => {
	const empty = (async () => jsonResponse([])) as unknown as typeof fetch;
	expect(await getRemoteVersionHistory({ fetchImpl: empty })).toEqual([]);
	const notArray = (async () =>
		jsonResponse({ history: [] })) as unknown as typeof fetch;
	__resetVersionHistoryCacheForTest();
	expect(await getRemoteVersionHistory({ fetchImpl: notArray })).toEqual([]);
});
