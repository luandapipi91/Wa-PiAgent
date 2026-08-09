// 通用设置读写（系统设置 > 通用）：pi 自动重试配置 + HTTP 空闲超时。
//
// 背景：pi 子进程以 PI_CODING_AGENT_DIR=~/.pi/agent 启动，pi 的 settings-manager
// 从同一 settings.json 读取：
//   - retry 字段（maxRetries / baseDelayMs，指数退避 delay = baseDelayMs × 2^(n-1)）
//   - httpIdleTimeoutMs（pi-coding-agent 的 undici dispatcher 用作 headersTimeout /
//     bodyTimeout，控制 LLM 请求空闲超时）。物理断网（连接后挂死）时 pi-ai 的 fetch
//     本身无超时，全靠这个值兜底——超时后 undici 抛 HeadersTimeoutError → pi-ai 归为
//     retryable → auto_retry → agent_settled 终态链，前端才不会永远卡"对话中"。
//     pi 默认 300000ms（5min）偏长，wa-pi 默认 120000ms（2min）让断网后更快反馈。
// wa-pi 侧读写均为 read-modify-write，保留文件内其他字段。
//
// 运行中的 pi 进程在启动时已加载 settings，保存后需重建进程才生效——
// 由 ws-server 的 settings:save handler 调 agentManager.markAllDirty() 保证。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WA_PI_DIR } from "@wa-pi/shared";
import type { RetrySettings, TrashSettings } from "@wa-pi/shared";

/** 与 pi settings-manager 的默认值对齐（未配置时的回退） */
export const RETRY_DEFAULTS: RetrySettings = {
	maxRetries: 3,
	baseDelayMs: 2000,
};
/** 产品上限：重试最多 10 次 */
export const MAX_RETRIES_LIMIT = 10;
/** 退避基数合法范围（ms）：0.5s - 60s */
export const BASE_DELAY_MIN_MS = 500;
export const BASE_DELAY_MAX_MS = 60_000;
/** HTTP 空闲超时默认值（ms）：pi 官方默认 300000（5min）偏长，
 *  wa-pi 收紧到 120000（2min）——物理断网（连接后挂死）后 2 分钟内 undici 超时
 *  → pi 走 auto_retry → agent_settled，前端不再无限"对话中"。 */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 120_000;

const SETTINGS_FILE = join(WA_PI_DIR, "settings.json");

async function readSettingsJson(file: string): Promise<Record<string, any>> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return {};
	}
}

export async function loadRetrySettings(
	file: string = SETTINGS_FILE,
): Promise<RetrySettings> {
	const raw = (await readSettingsJson(file)).retry ?? {};
	return {
		maxRetries:
			typeof raw.maxRetries === "number"
				? raw.maxRetries
				: RETRY_DEFAULTS.maxRetries,
		baseDelayMs:
			typeof raw.baseDelayMs === "number"
				? raw.baseDelayMs
				: RETRY_DEFAULTS.baseDelayMs,
	};
}

/**
 * 校验并保存 retry 配置（read-modify-write，保留其他字段）。
 * @throws Error 校验失败（message 直接回给前端展示）
 */
export async function saveRetrySettings(
	retry: RetrySettings,
	file: string = SETTINGS_FILE,
): Promise<RetrySettings> {
	const { maxRetries, baseDelayMs } = retry ?? ({} as RetrySettings);
	if (
		!Number.isInteger(maxRetries) ||
		maxRetries < 0 ||
		maxRetries > MAX_RETRIES_LIMIT
	) {
		throw new Error(`重试次数需为 0-${MAX_RETRIES_LIMIT} 的整数`);
	}
	if (
		!Number.isInteger(baseDelayMs) ||
		baseDelayMs < BASE_DELAY_MIN_MS ||
		baseDelayMs > BASE_DELAY_MAX_MS
	) {
		throw new Error(
			`重试间隔需为 ${BASE_DELAY_MIN_MS}-${BASE_DELAY_MAX_MS}ms 的整数`,
		);
	}
	const settings = await readSettingsJson(file);
	// merge 而非覆盖：保留 retry.provider（timeoutMs/maxRetries/maxRetryDelayMs）、
	// retry.enabled 等 wa-pi 未管理但 pi 读取的子字段（见 pi 官方 settings 文档）。
	settings.retry = { ...settings.retry, maxRetries, baseDelayMs };
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(settings, null, 2), "utf8");
	return { maxRetries, baseDelayMs };
}

/** 回收站自动归档/清除默认设置（持久化在 settings.json.trash） */
export const TRASH_DEFAULTS: TrashSettings = {
	autoArchiveEnabled: true,
	autoArchiveDays: 7,
	autoPurgeEnabled: false,
	autoPurgeDays: 30,
};

/** 读取回收站设置；未配置或字段缺失时逐项回退默认值（read-modify-write 保留其他字段） */
export async function loadTrashSettings(
	file: string = SETTINGS_FILE,
): Promise<TrashSettings> {
	const trash = (await readSettingsJson(file)).trash;
	if (!trash || typeof trash !== "object") return { ...TRASH_DEFAULTS };
	return {
		autoArchiveEnabled:
			typeof trash.autoArchiveEnabled === "boolean"
				? trash.autoArchiveEnabled
				: TRASH_DEFAULTS.autoArchiveEnabled,
		autoArchiveDays:
			typeof trash.autoArchiveDays === "number"
				? trash.autoArchiveDays
				: TRASH_DEFAULTS.autoArchiveDays,
		autoPurgeEnabled:
			typeof trash.autoPurgeEnabled === "boolean"
				? trash.autoPurgeEnabled
				: TRASH_DEFAULTS.autoPurgeEnabled,
		autoPurgeDays:
			typeof trash.autoPurgeDays === "number"
				? trash.autoPurgeDays
				: TRASH_DEFAULTS.autoPurgeDays,
	};
}

/** 保存回收站设置（read-modify-write，保留 settings.json 内其他字段）。
 *  保存边界 clamp 到 [1, 365]：负数或 0 会导致全量归档/清除，保存即归一化。 */
export async function saveTrashSettings(
	trash: TrashSettings,
	file: string = SETTINGS_FILE,
): Promise<TrashSettings> {
	// clamp 到合理范围（保存边界是权威边界）
	const clamped: TrashSettings = {
		autoArchiveEnabled: trash.autoArchiveEnabled,
		autoArchiveDays: Math.max(1, Math.min(365, Math.floor(trash.autoArchiveDays))),
		autoPurgeEnabled: trash.autoPurgeEnabled,
		autoPurgeDays: Math.max(1, Math.min(365, Math.floor(trash.autoPurgeDays))),
	};
	const settings = await readSettingsJson(file);
	settings.trash = clamped;
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(settings, null, 2), "utf8");
	return clamped;
}

/** 读取 HTTP 空闲超时（ms）；未配置或非数字返回 wa-pi 默认值（非 pi 的 300000） */
export async function loadHttpIdleTimeoutMs(
	file: string = SETTINGS_FILE,
): Promise<number> {
	const raw = (await readSettingsJson(file)).httpIdleTimeoutMs;
	return typeof raw === "number" ? raw : DEFAULT_HTTP_IDLE_TIMEOUT_MS;
}

/**
 * 保存 HTTP 空闲超时（read-modify-write，保留其他字段）。
 */
export async function saveHttpIdleTimeoutMs(
	timeoutMs: number,
	file: string = SETTINGS_FILE,
): Promise<number> {
	const settings = await readSettingsJson(file);
	settings.httpIdleTimeoutMs = timeoutMs;
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(settings, null, 2), "utf8");
	return timeoutMs;
}
