import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import type { ChannelConfig } from "@wa-pi/shared";

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
