import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	CHANNELS_FILE,
	CHANNEL_SESSIONS_FILE,
	SYSTEM_PROJECT_ID,
	type ChannelConfig,
} from "@wa-pi/shared";

/** IM 会话映射：一个 IM 对话（channelId+chatId）在每个项目下对应一个稳定 hiagent 会话 */
export interface ChannelSessionMapping {
	channelId: string;
	chatId: string;
	chatType: "single" | "group";
	/** /use 指令切换；默认 __system__（默认工作区） */
	currentProjectId: string;
	/** projectId → sessionId */
	sessions: Record<string, string>;
	/** 已归档的会话 id（/new 产生的历史会话）；listConversations 据此在 IM tab 展示历史 */
	historySessionIds?: string[];
	lastMessagePreview: string;
	updatedAt: number;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return fallback; // 文件不存在/损坏 → 回退，不抛错
	}
}

async function writeJson(file: string, data: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

export async function loadChannels(
	file: string = CHANNELS_FILE,
): Promise<ChannelConfig[]> {
	const raw = await readJson<{ channels?: ChannelConfig[] }>(file, {});
	const list = Array.isArray(raw.channels) ? raw.channels : [];
	// 旧数据兼容：缺省字段归一化，不写盘
	for (const c of list) {
		if (!c.defaultProjectId) c.defaultProjectId = SYSTEM_PROJECT_ID;
		if (typeof c.allowProjectSwitch !== "boolean") c.allowProjectSwitch = false;
	}
	return list;
}

export async function saveChannels(
	channels: ChannelConfig[],
	file: string = CHANNELS_FILE,
): Promise<void> {
	await writeJson(file, { schemaVersion: 1, channels });
}

export async function loadChannelMappings(
	file: string = CHANNEL_SESSIONS_FILE,
): Promise<ChannelSessionMapping[]> {
	const raw = await readJson<{ mappings?: ChannelSessionMapping[] }>(file, {});
	return Array.isArray(raw.mappings) ? raw.mappings : [];
}

export async function saveChannelMappings(
	mappings: ChannelSessionMapping[],
	file: string = CHANNEL_SESSIONS_FILE,
): Promise<void> {
	await writeJson(file, { schemaVersion: 1, mappings });
}

const VALID_TYPES = new Set(["wecom", "wechat", "feishu", "qq", "mock"]);
const VALID_GRANULARITY = new Set(["minimal", "simple", "standard"]);

/** 校验渠道入参；合法返回 null，非法返回中文错误（直接回前端展示） */
export function validateChannelInput(
	input: Omit<ChannelConfig, "id" | "createdAt">,
): string | null {
	if (!input.name?.trim()) return "机器人名称不能为空";
	if (!VALID_TYPES.has(input.type)) return `不支持的渠道类型: ${input.type}`;
	if (!input.credentials?.botId?.trim()) return "Bot ID 不能为空";
	if (!input.credentials?.secret?.trim()) return "Secret 不能为空";
	if (!VALID_GRANULARITY.has(input.replyGranularity))
		return `非法的回复粒度: ${input.replyGranularity}`;
	// defaultProjectId 缺失回退默认工作区（与 loadChannels 读取兜底一致，不报错）
	if (!input.defaultProjectId) input.defaultProjectId = SYSTEM_PROJECT_ID;
	return null;
}

/** secret 脱敏：保留尾 4 位 */
export function maskSecret(secret: string): string {
	return secret.length > 4 ? `****${secret.slice(-4)}` : "****";
}
