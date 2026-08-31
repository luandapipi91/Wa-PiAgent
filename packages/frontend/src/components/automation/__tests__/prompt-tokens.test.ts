import { describe, test, expect } from "bun:test";
import {
	parseImPushTokens,
	imPushToken,
	toPromptHtml,
	HAS_IM_PUSH_RE,
} from "../prompt-tokens";

describe("parseImPushTokens", () => {
	test("解析 bot/ct 两段", () => {
		expect(
			parseImPushTokens(
				"推给 @im-push-to(ch_aaa,ct_p01) 和 @im-push-to(ch_bbb,ct_p02)",
			),
		).toEqual([
			{ channelId: "ch_aaa", contactId: "ct_p01" },
			{ channelId: "ch_bbb", contactId: "ct_p02" },
		]);
	});

	test("无标记空数组", () => {
		expect(parseImPushTokens("无标记")).toEqual([]);
	});

	test("旧 @ct_ 裸格式不匹配（已废弃）", () => {
		expect(parseImPushTokens("@ct_p01")).toEqual([]);
	});
});

describe("imPushToken", () => {
	test("构造存储形态", () => {
		expect(imPushToken("ch_aaa", "ct_p01")).toBe("@im-push-to(ch_aaa,ct_p01)");
	});
});

describe("HAS_IM_PUSH_RE（无 g，可安全 .test）", () => {
	test("连续调用无 lastIndex 状态污染", () => {
		expect(HAS_IM_PUSH_RE.test("x @im-push-to(ch_a,ct_b)")).toBe(true);
		expect(HAS_IM_PUSH_RE.test("x @im-push-to(ch_a,ct_b)")).toBe(true);
		expect(HAS_IM_PUSH_RE.test("无")).toBe(false);
	});
});

describe("toPromptHtml", () => {
	const meta = (id: string) =>
		id === "ct_p01"
			? { label: "张三", valid: true }
			: { label: id, valid: false };

	test("联系人标记渲染为 data-token chip，显示联系人名", () => {
		const html = toPromptHtml("推给 @im-push-to(ch_aaa,ct_p01)", meta);
		expect(html).toContain('data-token="@im-push-to(ch_aaa,ct_p01)"');
		expect(html).toContain("张三");
		expect(html).toContain("chip-im");
		expect(html).toContain('contenteditable="false"');
		// 图标 + 人名（非原文 token、非 emoji）
		expect(html).toContain("<svg");
		expect(html).not.toContain("📨");
	});

	test("失效联系人灰化：显示 id 且带 invalid 类", () => {
		const html = toPromptHtml("推给 @im-push-to(ch_aaa,ct_gone)", meta);
		expect(html).toContain("chip-im-invalid");
		expect(html).toContain("ct_gone");
	});

	test("联系人 chip 图标区分人/群：person 用 user（1 path），group 用 users（3 path）", () => {
		const meta2 = (id: string) =>
			id === "ct_g01"
				? { label: "wr_group", valid: true, kind: "group" as const }
				: { label: "张三", valid: true, kind: "person" as const };
		const personHtml = toPromptHtml("@im-push-to(ch_aaa,ct_p01)", meta2);
		const groupHtml = toPromptHtml("@im-push-to(ch_aaa,ct_g01)", meta2);
		expect(personHtml.match(/<path/g)?.length).toBe(1);
		expect(groupHtml.match(/<path/g)?.length).toBe(3);
	});

	test("技能 chip 复用聊天渲染：$[名] 变 chip-skill", () => {
		const html = toPromptHtml("执行 $[日报生成] 任务", meta);
		expect(html).toContain('data-token="$[日报生成]"');
		expect(html).toContain("chip-skill");
	});

	test("普通文本转义", () => {
		const html = toPromptHtml("a<b>&c", meta);
		expect(html).toContain("&lt;b&gt;");
	});
});
