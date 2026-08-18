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
import { getSystemProxy } from "os-proxy-config";
import { WA_PI_DIR } from "@wa-pi/shared";
import type {
	RetrySettings,
	TrashSettings,
	ProxySettings,
} from "@wa-pi/shared";

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
/** HTTP 空闲超时下限（ms）：0 会被 pi 翻译成 int32 上限（≈24.8 天）永不超时，禁止 */
export const HTTP_IDLE_TIMEOUT_MIN_MS = 10_000;

const SETTINGS_FILE = join(WA_PI_DIR, "settings.json");

async function readSettingsJson(file: string): Promise<Record<string, any>> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return {};
	}
}

async function writeSettingsJson(
	file: string,
	settings: Record<string, any>,
): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(settings, null, 2), "utf8");
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
		autoArchiveDays: Math.max(
			1,
			Math.min(365, Math.floor(trash.autoArchiveDays)),
		),
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
	if (!Number.isInteger(timeoutMs) || timeoutMs < HTTP_IDLE_TIMEOUT_MIN_MS) {
		throw new Error(`HTTP 空闲超时需为 ≥${HTTP_IDLE_TIMEOUT_MIN_MS}ms 的整数`);
	}
	const settings = await readSettingsJson(file);
	settings.httpIdleTimeoutMs = timeoutMs;
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(settings, null, 2), "utf8");
	return timeoutMs;
}

/**
 * 启动时确保 settings.json 落盘 httpIdleTimeoutMs 默认值。
 * 背景：pi 子进程启动时从 settings.json 读该字段，缺省时回退 pi 官方默认 300000ms
 * （而非 wa-pi 宣称的 120000ms），物理断网后前端要多卡 3 分钟才有反馈。
 * 仅在字段缺失/非数字时写入，已有用户配置不动（read-modify-write 保留其他字段）。
 */
export async function ensureHttpIdleTimeout(
	file: string = SETTINGS_FILE,
): Promise<void> {
	const settings = await readSettingsJson(file);
	if (typeof settings.httpIdleTimeoutMs === "number") return;
	settings.httpIdleTimeoutMs = DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(settings, null, 2), "utf8");
}

/** 系统代理默认值（未配置时：关闭 + 空代理 = 直连） */
export const PROXY_DEFAULTS: ProxySettings = {
	useSystemProxy: false,
	httpProxy: "",
};

/** 读取系统代理设置（useSystemProxy + httpProxy），字段缺失逐项回退默认 */
export async function loadProxySettings(
	file: string = SETTINGS_FILE,
): Promise<ProxySettings> {
	const raw = await readSettingsJson(file);
	return {
		useSystemProxy:
			typeof raw.useSystemProxy === "boolean"
				? raw.useSystemProxy
				: PROXY_DEFAULTS.useSystemProxy,
		httpProxy:
			typeof raw.httpProxy === "string" ? raw.httpProxy : PROXY_DEFAULTS.httpProxy,
	};
}

/** 保存系统代理设置（read-modify-write，保留其他字段） */
export async function saveProxySettings(
	proxy: ProxySettings,
	file: string = SETTINGS_FILE,
): Promise<ProxySettings> {
	const normalized: ProxySettings = {
		useSystemProxy: proxy.useSystemProxy === true,
		httpProxy: typeof proxy.httpProxy === "string" ? proxy.httpProxy : "",
	};
	const settings = await readSettingsJson(file);
	settings.useSystemProxy = normalized.useSystemProxy;
	settings.httpProxy = normalized.httpProxy;
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(settings, null, 2), "utf8");
	return normalized;
}

/**
 * 读系统代理地址（跨平台，网页端可用——不依赖 Electron）。
 * 用 os-proxy-config：Windows 读注册表 / macOS 读 scutil / Linux 读 *_PROXY 环境变量。
 * 只支持 http/https 代理（SOCKS/PAC 的 proxyUrl 不适合直接塞 HTTP_PROXY，暂视为直连）。
 * 读不到返回空串（表示直连）。
 */
export async function readSystemProxy(): Promise<string> {
	const env = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
	if (env) {
		console.log(`[proxy] 环境变量已有代理: ${env}`);
		return env;
	}
	try {
		const proxy = await getSystemProxy();
		const url = proxy?.proxyUrl ?? "";
		console.log(
			`[proxy] os-proxy-config 读到: proxyUrl=${url || "(无)"} noProxy=${JSON.stringify(proxy?.noProxy ?? [])}`,
		);
		return url.startsWith("http://") || url.startsWith("https://") ? url : "";
	} catch (e) {
		console.log(
			`[proxy] 读系统代理失败: ${e instanceof Error ? e.message : String(e)}`,
		);
		return "";
	}
}

/**
 * 应用系统代理到进程环境变量（同时设置大小写，覆盖 undici/Bun fetch 与 curl/wget）。
 * 开启时优先用保存的 httpProxy；为空则从系统（readProxy）兜底读当前系统代理。
 * 关闭，或开启但读不到代理 → 清空恢复直连。
 * Bun 的 fetch 与 pi 子进程（继承 env）的 undici EnvHttpProxyAgent 读大写；
 * curl/wget 读小写 http_proxy/https_proxy。
 */
export async function applySystemProxy(
	file: string = SETTINGS_FILE,
	readProxy: () => string | Promise<string> = readSystemProxy,
): Promise<void> {
	const { useSystemProxy, httpProxy } = await loadProxySettings(file);
	const effective = useSystemProxy ? httpProxy || (await readProxy()) : "";
	console.log(
		`[proxy] applySystemProxy: useSystemProxy=${useSystemProxy} 保存的 httpProxy=${httpProxy || "(空)"} → 最终代理=${effective || "(直连)"}`,
	);
	if (effective) {
		process.env.HTTP_PROXY = effective;
		process.env.HTTPS_PROXY = effective;
		process.env.http_proxy = effective;
		process.env.https_proxy = effective;
	} else {
		delete process.env.HTTP_PROXY;
		delete process.env.HTTPS_PROXY;
		delete process.env.http_proxy;
		delete process.env.https_proxy;
	}
}

/** 产物分享默认配置（未配置时：无 token + 默认渠道 edgeone + 无自定义域名） */
export const SHARE_DEFAULTS = {
	token: "",
	channel: "edgeone",
	customDomain: "",
} as const;
export interface ShareSettings {
	token: string;
	channel: string;
	/** 自定义加速域名（可选）；空 = 用项目预设域名 */
	customDomain: string;
}

/** 读取产物分享配置；字段缺失逐项回退默认值 */
export async function loadShareSettings(
	file: string = SETTINGS_FILE,
): Promise<ShareSettings> {
	const raw = (await readSettingsJson(file)).share ?? {};
	return {
		token: raw.token ?? SHARE_DEFAULTS.token,
		channel: raw.channel ?? SHARE_DEFAULTS.channel,
		customDomain: raw.customDomain ?? SHARE_DEFAULTS.customDomain,
	};
}

/** 保存产物分享配置（read-modify-write）。token 传空串时保留已保存值：
 * 前端编辑自定义域名等字段时不会把 token 冲掉。 */
export async function saveShareSettings(
	share: ShareSettings,
	file: string = SETTINGS_FILE,
): Promise<ShareSettings> {
	const settings = await readSettingsJson(file);
	const prevToken = settings.share?.token ?? "";
	settings.share = {
		token: share.token !== "" ? share.token : prevToken,
		channel: share.channel ?? SHARE_DEFAULTS.channel,
		customDomain: share.customDomain ?? SHARE_DEFAULTS.customDomain,
	};
	await writeSettingsJson(file, settings);
	return {
		token: settings.share.token,
		channel: settings.share.channel,
		customDomain: settings.share.customDomain,
	};
}
