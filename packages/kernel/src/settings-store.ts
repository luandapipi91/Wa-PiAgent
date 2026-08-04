// 通用设置读写（系统设置 > 通用）：目前仅 pi 自动重试配置。
//
// 背景：pi 子进程以 PI_CODING_AGENT_DIR=~/.wa-pi 启动，pi 的 settings-manager
// 从同一 settings.json 的 retry 字段读取自动重试配置（maxRetries / baseDelayMs，
// 指数退避 delay = baseDelayMs × 2^(n-1)）。wa-pi 侧读写均为 read-modify-write，
// 保留文件内其他字段（waPiPackages / providers 等 wa-pi 自有键与 pi 键互不干扰）。
//
// 运行中的 pi 进程在启动时已加载 settings，保存后需重建进程才生效——
// 由 ws-server 的 settings:save handler 调 agentManager.markAllDirty() 保证。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WA_PI_DIR } from "@wa-pi/shared";
import type { RetrySettings } from "@wa-pi/shared";

/** 与 pi settings-manager 的默认值对齐（未配置时的回退） */
export const RETRY_DEFAULTS: RetrySettings = { maxRetries: 3, baseDelayMs: 2000 };
/** 产品上限：重试最多 10 次 */
export const MAX_RETRIES_LIMIT = 10;
/** 退避基数合法范围（ms）：0.5s - 60s */
export const BASE_DELAY_MIN_MS = 500;
export const BASE_DELAY_MAX_MS = 60_000;

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
	settings.retry = { maxRetries, baseDelayMs };
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(settings, null, 2), "utf8");
	return { maxRetries, baseDelayMs };
}
