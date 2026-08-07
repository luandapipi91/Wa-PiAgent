import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadChannels,
	saveChannels,
	loadChannelMappings,
	saveChannelMappings,
	validateChannelInput,
	maskSecret,
	type ChannelSessionMapping,
} from "../src/channel-store";
import { SYSTEM_PROJECT_ID, type ChannelConfig } from "@wa-pi/shared";

let dir: string;
let channelsFile: string;
let mappingsFile: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wa-pi-channel-test-"));
	channelsFile = join(dir, "channels.json");
	mappingsFile = join(dir, "channel-sessions.json");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const sample: ChannelConfig = {
	id: "ch_1",
	type: "wecom",
	name: "客服机器人",
	enabled: true,
	credentials: { botId: "ww123", secret: "secret-abcd" },
	agentName: "前端开发者",
	model: null,
	extraSystemPrompt: "回复控制在200字内",
	replyGranularity: "standard",
	defaultProjectId: "__system__",
	allowProjectSwitch: false,
	createdAt: 1786000000,
};

test("loadChannels：文件不存在 → 空数组", async () => {
	expect(await loadChannels(channelsFile)).toEqual([]);
});

test("saveChannels/loadChannels：往返一致且写盘", async () => {
	await saveChannels([sample], channelsFile);
	expect(await loadChannels(channelsFile)).toEqual([sample]);
	const onDisk = JSON.parse(await readFile(channelsFile, "utf8"));
	expect(onDisk.channels[0].credentials.botId).toBe("ww123");
});

test("loadChannels：文件损坏 → 空数组不抛错", async () => {
	await saveChannels([sample], channelsFile);
	await rm(channelsFile);
	const { writeFile } = await import("node:fs/promises");
	await writeFile(channelsFile, "{broken", "utf8");
	expect(await loadChannels(channelsFile)).toEqual([]);
});

test("validateChannelInput：缺 botId → 中文报错", () => {
	expect(validateChannelInput({ ...sample, credentials: { botId: "", secret: "x" } })).toContain("Bot ID");
});

test("validateChannelInput：非法 type/granularity → 报错；合法 → null", () => {
	expect(validateChannelInput({ ...sample, type: "msn" as any })).toContain("渠道类型");
	expect(validateChannelInput({ ...sample, replyGranularity: "verbose" as any })).toContain("回复粒度");
	expect(validateChannelInput(sample)).toBeNull();
});

test("maskSecret：保留尾4位", () => {
	expect(maskSecret("secret-abcd")).toBe("****abcd");
	expect(maskSecret("abc")).toBe("****");
});

test("mappings：保存/读取往返一致", async () => {
	const m: ChannelSessionMapping = {
		channelId: "ch_1",
		chatId: "wr_xxx",
		chatType: "group",
		currentProjectId: "__system__",
		sessions: { __system__: "sess_1" },
		lastMessagePreview: "你好",
		updatedAt: 1786000001,
	};
	await saveChannelMappings([m], mappingsFile);
	expect(await loadChannelMappings(mappingsFile)).toEqual([m]);
	expect(await loadChannelMappings(join(dir, "nonexistent.json"))).toEqual([]);
});

test("loadChannels: 旧数据（无 defaultProjectId/allowProjectSwitch）读取兜底", async () => {
	// 模拟旧版 channels.json：不含新字段
	const file = join(dir, "channels.json");
	await writeFile(
		file,
		JSON.stringify({
			schemaVersion: 1,
			channels: [
				{
					id: "ch_old",
					type: "wecom",
					name: "旧机器人",
					enabled: true,
					credentials: { botId: "b1", secret: "s1" },
					agentName: "前端开发者",
					model: null,
					extraSystemPrompt: "",
					replyGranularity: "simple",
					createdAt: 1,
				},
			],
		}),
		"utf8",
	);
	const list = await loadChannels(file);
	expect(list).toHaveLength(1);
	expect(list[0].defaultProjectId).toBe(SYSTEM_PROJECT_ID);
	expect(list[0].allowProjectSwitch).toBe(false);
});

test("loadChannels: 新数据保留显式配置值", async () => {
	const file = join(dir, "channels.json");
	await writeFile(
		file,
		JSON.stringify({
			schemaVersion: 1,
			channels: [
				{
					id: "ch_new",
					type: "wecom",
					name: "新机器人",
					enabled: true,
					credentials: { botId: "b1", secret: "s1" },
					agentName: "前端开发者",
					model: null,
					extraSystemPrompt: "",
					replyGranularity: "simple",
					defaultProjectId: "proj_x",
					allowProjectSwitch: true,
					createdAt: 1,
				},
			],
		}),
		"utf8",
	);
	const list = await loadChannels(file);
	expect(list[0].defaultProjectId).toBe("proj_x");
	expect(list[0].allowProjectSwitch).toBe(true);
});

test("validateChannelInput: defaultProjectId 缺失时回退默认工作区（不报错）", () => {
	const err = validateChannelInput({
		type: "wecom",
		name: "机器人",
		enabled: true,
		credentials: { botId: "b1", secret: "s1" },
		agentName: "前端开发者",
		model: null,
		extraSystemPrompt: "",
		replyGranularity: "simple",
		// 故意不传 defaultProjectId / allowProjectSwitch
	} as any);
	expect(err).toBeNull();
});
