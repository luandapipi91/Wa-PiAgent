// parseChannelMentions 前端纯函数单元测试（bun:test）。
// 用例与后端 packages/kernel/tests/robot-push.test.ts 保持一致，确保前后端契约相同。
import { describe, test, expect } from "bun:test";
import { parseChannelMentions } from "./channel-mentions";

describe("parseChannelMentions", () => {
	test("提取单个 @bot_xxx", () => {
		expect(parseChannelMentions("请把结果通过 @bot_abc123 推送给我")).toEqual([
			"bot_abc123",
		]);
	});

	test("提取多个 @bot_xxx", () => {
		expect(
			parseChannelMentions("通过 @bot_aaa 推送日报，@bot_bbb 推送周报"),
		).toEqual(["bot_aaa", "bot_bbb"]);
	});

	test("无 @ 标记返回空数组", () => {
		expect(parseChannelMentions("请帮我整理文件")).toEqual([]);
	});

	test("去重", () => {
		expect(parseChannelMentions("@bot_aaa 先分析，再 @bot_aaa 推送")).toEqual([
			"bot_aaa",
		]);
	});

	test("不误匹配邮箱", () => {
		expect(parseChannelMentions("发邮件给 user@example.com")).toEqual([]);
	});

	test("bot ID 含连字符和下划线", () => {
		expect(parseChannelMentions("推送到 @bot_my-channel_01")).toEqual([
			"bot_my-channel_01",
		]);
	});

	test("不匹配纯 @ 开头非 bot_ 前缀", () => {
		expect(parseChannelMentions("@username 你好，@bot_real 来一下")).toEqual([
			"bot_real",
		]);
	});
});
