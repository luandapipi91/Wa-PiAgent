// @im-push-to(ch_xxx,ct_xxx) chip 渲染测试：
// chip-im 正常渲染 / 未注册灰化 / expandTokens 原样保留 / segments 往返
import { beforeEach, expect, test } from "bun:test";
import {
	clearContactMeta,
	ensureChipStyles,
	expandTokens,
	registerContactMeta,
	segmentsToText,
	textToSegments,
	textToHtml,
} from "./tokens";

beforeEach(() => {
	clearContactMeta();
	ensureChipStyles();
});

test("textToSegments 把 @im-push-to 标记解析为 im segment", () => {
	const segs = textToSegments("汇报 @im-push-to(ch_abc,ct_123) 给老板");
	expect(segs).toEqual([
		{ type: "text", value: "汇报 " },
		{ type: "im", value: "@im-push-to(ch_abc,ct_123)" },
		{ type: "text", value: " 给老板" },
	]);
});

test("textToHtml 渲染已注册联系人为 chip-im（含发送给前缀与显示名）", () => {
	registerContactMeta("ct_123", { label: "张三", kind: "person" });
	const html = textToHtml("@im-push-to(ch_abc,ct_123)");
	expect(html).toContain("chip chip-im");
	expect(html).not.toContain("chip-im-invalid");
	expect(html).toContain('data-token="@im-push-to(ch_abc,ct_123)"');
	expect(html).toContain("发送给：");
	expect(html).toContain("张三");
	expect(html).toContain('contenteditable="false"');
});

test("textToHtml 未注册联系人 → chip-im-invalid 灰化显示 contactId", () => {
	const html = textToHtml("@im-push-to(ch_abc,ct_gone)");
	expect(html).toContain("chip-im-invalid");
	expect(html).toContain("ct_gone");
});

test("group 联系人 chip 用 users 图标", () => {
	registerContactMeta("ct_g1", { label: "周报群", kind: "group" });
	const html = textToHtml("@im-push-to(ch_abc,ct_g1)");
	expect(html).toContain("周报群");
	expect(html).toContain("<svg"); // iconSvg("users")
});

test("expandTokens 不展开 @im-push-to（原样保留给 kernel 解析）", () => {
	const text = "做完推送 @im-push-to(ch_abc,ct_123)";
	expect(expandTokens(text)).toBe(text);
});

test("segmentsToText 往返还原 im token", () => {
	const text = "汇报 @im-push-to(ch_abc,ct_123) 完";
	expect(segmentsToText(textToSegments(text))).toBe(text);
});
