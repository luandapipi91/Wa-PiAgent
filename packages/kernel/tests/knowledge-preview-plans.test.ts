// 预览计划令牌（任务 9，S13）：预览 → 创建之间目录可能被改动，
// 令牌把「预览时看到的可索引清单」留在 kernel 内存里，创建时比对并报告差异。
// 纯函数单测（不落盘、不启服务）：假目录字符串即可，无需真实文件系统。
import { test, expect } from "bun:test";
import {
	rememberPreview,
	evaluatePreviewPlan,
	peekPreviewPlan,
	expirePreviewPlanForTest,
	PREVIEW_PLAN_MAX,
	PREVIEW_PLAN_TTL_MS,
} from "../src/knowledge/preview-plans";

const dir = "/fake/kb";

test("preview 返回 planToken，create 带同一 token：目录未变时 changed=false", () => {
	const token = rememberPreview(dir, ["a.md", "b.txt"]);
	expect(typeof token).toBe("string");
	expect(evaluatePreviewPlan(token, dir, ["a.md", "b.txt"])).toEqual({
		hit: true,
		changed: false,
		token,
	});
});

test("目录在预览后变化：changed=true 且列出新增/减少的文件", () => {
	const token = rememberPreview(dir, ["a.md", "b.txt"]);
	const r = evaluatePreviewPlan(token, dir, ["a.md", "c.md"]);
	expect(r.hit).toBe(true);
	expect(r.changed).toBe(true);
	expect(r.added).toEqual(["c.md"]);
	expect(r.removed).toEqual(["b.txt"]);
});

test("token 过期（TTL 10 分钟）或不存在：hit=false", () => {
	expect(evaluatePreviewPlan("nope", dir, [])).toEqual({ hit: false });

	const token = rememberPreview(dir, ["a.md"]);
	const expiredAt = Date.now() + PREVIEW_PLAN_TTL_MS + 1;
	expect(
		evaluatePreviewPlan(token, dir, ["a.md"], { now: expiredAt }),
	).toEqual({ hit: false });
});

test("token 绑定目录：换目录后同一 token 不算命中（不误报差异）", () => {
	const token = rememberPreview(dir, ["a.md"]);
	expect(evaluatePreviewPlan(token, "/fake/other", ["a.md"])).toEqual({
		hit: false,
	});
});

test("计划表最多保留 32 条：超出后最早的被淘汰（LRU 上限）", () => {
	const first = rememberPreview("/fake/kb-0", ["a.md"]);
	for (let i = 1; i <= PREVIEW_PLAN_MAX; i++) {
		rememberPreview(`/fake/kb-${i}`, ["a.md"]);
	}
	// 第 1 条已被挤出
	expect(evaluatePreviewPlan(first, "/fake/kb-0", ["a.md"])).toEqual({
		hit: false,
	});
	// 最新一条仍在
	const latest = rememberPreview("/fake/kb-latest", ["a.md"]);
	expect(evaluatePreviewPlan(latest, "/fake/kb-latest", ["a.md"]).hit).toBe(
		true,
	);
});

test("同目录重新预览覆盖旧计划：旧 token 失效（不囤积同目录副本）", () => {
	const first = rememberPreview(dir, ["a.md"]);
	const second = rememberPreview(dir, ["a.md", "b.md"]);
	// 旧 token 被同目录的新计划顶掉
	expect(evaluatePreviewPlan(first, dir, ["a.md"])).toEqual({ hit: false });
	expect(evaluatePreviewPlan(second, dir, ["a.md", "b.md"])).toEqual({
		hit: true,
		changed: false,
		token: second,
	});
});

test("peekPreviewPlan 只判存在/过期/目录一致，不比对清单", () => {
	const token = rememberPreview(dir, ["a.md"]);
	expect(peekPreviewPlan(token, dir)).toEqual({ hit: true });
	expect(peekPreviewPlan("nope", dir)).toEqual({ hit: false });
	expect(peekPreviewPlan(token, "/fake/other")).toEqual({ hit: false });
	const expiredAt = Date.now() + PREVIEW_PLAN_TTL_MS + 1;
	expect(peekPreviewPlan(token, dir, { now: expiredAt })).toEqual({
		hit: false,
	});
});

// 体积上限（I4）：32 条上限只管条数、不管体积，单份清单可能上百万路径。
// 超过 20000 条就放弃登记计划：创建照常，只是不再给「预览已过期」提示。
test("清单超过 20000 条：rememberPreview 返回空串，不登记计划", () => {
	const huge = Array.from({ length: 20_001 }, (_, i) => `f${i}.md`);
	expect(rememberPreview(dir, huge)).toBe("");
	// 空 token 天然不命中：创建侧照建库，只是拿不到差异
	expect(evaluatePreviewPlan("", dir, huge)).toEqual({ hit: false });
	expect(peekPreviewPlan("", dir)).toEqual({ hit: false });
});

test("清单正好 20000 条（上限内）：照常登记计划", () => {
	const big = Array.from({ length: 20_000 }, (_, i) => `f${i}.md`);
	const token = rememberPreview(dir, big);
	expect(token).not.toBe("");
	expect(evaluatePreviewPlan(token, dir, big)).toEqual({
		hit: true,
		changed: false,
		token,
	});
});

test("expirePreviewPlanForTest：测试缝把令牌推到期后 peek 不命中", () => {
	const token = rememberPreview(dir, ["a.md"]);
	expirePreviewPlanForTest(token);
	expect(peekPreviewPlan(token, dir)).toEqual({ hit: false });
	expect(evaluatePreviewPlan(token, dir, ["a.md"])).toEqual({ hit: false });
});
