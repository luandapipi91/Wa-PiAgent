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
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { WA_PI_DIR } from "@wa-pi/shared";
import { KernelError } from "./kernel-error";
import { ensureProxyRelay } from "./proxy-relay";
import type {
	RetrySettings,
	TrashSettings,
	ProxySettings,
	KernelLanguage,
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

/** settings.json 顶层结构：已知字段有类型，未知字段 unknown（JSON 读写的通用容器） */
interface SettingsJson {
	retry?: Partial<RetrySettings>;
	trash?: Partial<TrashSettings>;
	share?: Partial<ShareSettings>;
	language?: KernelLanguage;
	httpIdleTimeoutMs?: number;
	useSystemProxy?: boolean;
	httpProxy?: string;
	[key: string]: unknown;
}

async function readSettingsJson(file: string): Promise<SettingsJson> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as SettingsJson;
	} catch {
		return {};
	}
}

async function writeSettingsJson(
	file: string,
	settings: SettingsJson,
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
		throw new KernelError("settings.invalidRetries", { max: MAX_RETRIES_LIMIT });
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
		throw new KernelError("settings.invalidIdleTimeout", {
			min: HTTP_IDLE_TIMEOUT_MIN_MS,
		});
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

// ===== 界面语言偏好（后端 i18n 基建）=====
/** 语言白名单：与前端 AppLanguage（zh/en）保持一致 */
export const LANGUAGE_WHITELIST = ["zh", "en"] as const;

/** 读取界面语言偏好；未配置/文件不存在/磁盘脏数据（白名单外）返回 undefined（跟随前端，不落默认值） */
export async function loadLanguage(
	file: string = SETTINGS_FILE,
): Promise<KernelLanguage | undefined> {
	const raw = (await readSettingsJson(file)).language;
	if (typeof raw !== "string") return undefined;
	return (LANGUAGE_WHITELIST as readonly string[]).includes(raw)
		? (raw as KernelLanguage)
		: undefined;
}

/** 保存界面语言偏好（read-modify-write，保留其他字段）。前端切换语言时经 REST 双写。
 *  @throws Error 白名单外的语言值 */
export async function saveLanguage(
	language: KernelLanguage,
	file: string = SETTINGS_FILE,
): Promise<KernelLanguage> {
	if (!(LANGUAGE_WHITELIST as readonly string[]).includes(language)) {
		throw new Error(
			`不支持的语言 "${String(language)}"（可选：${LANGUAGE_WHITELIST.join(" / ")}）`,
		);
	}
	const settings = await readSettingsJson(file);
	settings.language = language;
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(settings, null, 2), "utf8");
	return language;
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
 * 从 env 代理变量提取上游代理。
 * 本地中继（applySystemProxy 写入的 http://127.0.0.1:随机端口）不能作为中继自己的上游：
 * 上一实例残留的旧中继地址会让新中继上游指向已死端口（日志里的「上游=旧中继 → 模型请求 404」），
 * 同实例自身地址则造成回环死循环。返回 null 表示忽略该 env 值（继续读系统代理）。
 */
export function systemProxyFromEnv(env: string | undefined): string | null {
	if (!env) return null;
	try {
		const u = new URL(env);
		// URL.hostname 对 IPv6 保留方括号（[::1]），去掉后统一比较
		const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
		if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
			return null;
		}
		return env;
	} catch {
		return null; // 非法 URL 不作为上游，交给系统代理读取兜底
	}
}

/**
 * 解析 Windows 注册表 ProxyServer 值，返回可用的 http/https 代理 URL（空串=无代理）。
 * 格式兼容 windows-system-proxy 的解析逻辑：
 *   http://host:port          → 原样
 *   host:port                 → http://host:port
 *   http=host:port;https=...  → 取 http（无则取 https）
 */
export function parseWindowsProxyServer(server: string | undefined): string {
	const s = (server ?? "").trim();
	if (!s) return "";
	if (s.startsWith("http://") || s.startsWith("https://")) return s;
	if (s.includes("=")) {
		const map: Record<string, string> = {};
		for (const pair of s.split(";")) {
			const idx = pair.indexOf("=");
			if (idx > 0) {
				map[pair.slice(0, idx).trim().toLowerCase()] = pair.slice(idx + 1).trim();
			}
		}
		const http = map["http"] || map["https"];
		if (!http) return "";
		return http.includes("://") ? http : `http://${http}`;
	}
	return s.includes("://") ? s : `http://${s}`;
}

/**
 * 解析 reg query 输出中指定键名的值。
 * 输出形如：
 *   HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
 *       ProxyServer    REG_SZ    http://127.0.0.1:7890
 *       ProxyEnable    REG_DWORD    0x1
 * 支持 REG_SZ / REG_EXPAND_SZ / REG_DWORD（0x 十六进制转十进制字符串）。
 */
export function parseRegQueryValue(output: string, valueName: string): string {
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith(valueName)) continue;
		const parts = trimmed.split(/\s+/);
		if (parts.length < 3) continue;
		const type = parts[1];
		if (type === "REG_DWORD") {
			const hex = (parts[2] || "0").replace(/^0x/i, "");
			return String(parseInt(hex, 16) || 0);
		}
		if (type === "REG_SZ" || type === "REG_EXPAND_SZ") {
			return parts.slice(2).join(" ");
		}
	}
	return "";
}

/** 执行 reg query 读取注册表值（读不到返回空串） */
async function readRegValue(key: string, value: string): Promise<string> {
	return new Promise((resolve) => {
		// 兕底超时：同 readMacSystemProxy——mock/异常环境下 callback 可能永不调用。
		const guard = setTimeout(() => resolve(""), 5000);
		execFile(
			"reg",
			["query", key, "/v", value],
			{ windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 },
			(err, stdout) => {
				clearTimeout(guard);
				if (err) {
					console.log(`[proxy] reg query ${value} 失败: ${err.message}`);
					resolve("");
					return;
				}
				resolve(parseRegQueryValue(stdout, value));
			},
		);
	});
}

/**
 * Windows 读系统代理（注册表 HKCU Internet Settings）。
 * 用系统自带的 reg.exe，不依赖任何第三方/原生模块（彻底绕开 registry-js）。
 * 读不到或执行失败返回空串（直连兜底）。
 */
export async function readWindowsSystemProxy(): Promise<string> {
	const key =
		"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
	const [enable, server] = await Promise.all([
		readRegValue(key, "ProxyEnable"),
		readRegValue(key, "ProxyServer"),
	]);
	if (enable !== "1" || !server) return "";
	return parseWindowsProxyServer(server);
}

/**
 * 解析 scutil --proxy 输出（macOS），返回 http/https 代理 URL（空串=无代理）。
 * 输出形如：
 *   <dictionary> {
 *     HTTPEnable : 1
 *     HTTPProxy : 127.0.0.1
 *     HTTPPort : 7890
 *     HTTPSEnable : 0
 *     SOCKSEnable : 1
 *     SOCKSProxy : 127.0.0.1
 *     SOCKSPort : 1080
 *     ExceptionsList : <array> { ... }
 *   }
 * 优先 HTTP，其次 HTTPS，最后 SOCKS（SOCKS 统一按 http:// 返回由中继层转发）。
 */
export function parseScutilProxyOutput(output: string): string {
	const get = (key: string) => {
		const m = output.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m"));
		return m ? m[1].trim() : "";
	};
	const candidates = [
		{ enable: "HTTPEnable", host: "HTTPProxy", port: "HTTPPort" },
		{ enable: "HTTPSEnable", host: "HTTPSProxy", port: "HTTPSPort" },
		{ enable: "SOCKSEnable", host: "SOCKSProxy", port: "SOCKSPort" },
	];
	for (const c of candidates) {
		if (get(c.enable) !== "1") continue;
		const host = get(c.host);
		const port = get(c.port);
		if (!host || !port) continue;
		return `http://${host}:${port}`;
	}
	return "";
}

/** macOS 读系统代理：scutil --proxy（系统自带命令，纯 JS 子进程） */
async function readMacSystemProxy(): Promise<string> {
	return new Promise((resolve) => {
		// 兕底超时：execFile 自身的 timeout 只对真实子进程生效；测试 mock（mock.module
		// 替换 child_process）或异常环境下 callback 可能永不调用，曾致 kernel 启动
		// 永久挂死（全量测试卡死根因之一）。5s 后强制按「无代理」继续启动。
		const guard = setTimeout(() => resolve(""), 5000);
		execFile(
			"scutil",
			["--proxy"],
			{ timeout: 5000, maxBuffer: 64 * 1024 },
			(err, stdout) => {
				clearTimeout(guard);
				if (err) {
					console.log(`[proxy] scutil 读系统代理失败: ${err.message}`);
					resolve("");
					return;
				}
				resolve(parseScutilProxyOutput(stdout));
			},
		);
	});
}

/** Linux 读系统代理：环境变量（无第三方依赖） */
function readLinuxSystemProxy(): string {
	const env =
		process.env.HTTPS_PROXY ||
		process.env.HTTP_PROXY ||
		process.env.https_proxy ||
		process.env.http_proxy ||
		"";
	return env.startsWith("http://") || env.startsWith("https://") ? env : "";
}

/**
 * 读系统代理地址（跨平台，自研实现，零第三方依赖/零原生模块）：
 *   Windows：reg.exe 读注册表（系统自带，绕开 registry-js）
 *   macOS：scutil --proxy（系统自带）
 *   Linux：环境变量
 * 只支持 http/https 代理（SOCKS/PAC 的 proxyUrl 不适合直接塞 HTTP_PROXY，暂视为直连）。
 * 读不到返回空串（表示直连）。
 */
export async function readSystemProxy(): Promise<string> {
	const fromEnv = systemProxyFromEnv(
		process.env.HTTP_PROXY || process.env.HTTPS_PROXY,
	);
	if (fromEnv) {
		console.log(`[proxy] 环境变量已有代理: ${fromEnv}`);
		return fromEnv;
	}
	try {
		let url = "";
		if (process.platform === "win32") {
			url = await readWindowsSystemProxy();
		} else if (process.platform === "darwin") {
			url = await readMacSystemProxy();
		} else {
			url = readLinuxSystemProxy();
		}
		console.log(`[proxy] 系统代理读到: proxyUrl=${url || "(无)"}`);
		return url;
	} catch (e) {
		console.log(
			`[proxy] 读系统代理失败: ${e instanceof Error ? e.message : String(e)}`,
		);
		return "";
	}
}

/**
 * 回环 + 本地域名必须绕过代理（本地 bridge/中继始终直连），与已有 NO_PROXY 合并去重。
 * 注意：pi 子进程的 HTTP 客户端是 undici EnvHttpProxyAgent，no_proxy 只认完全匹配 /
 * 子域通配（.local/.internal），**不认 CIDR 网段**——内网 IP 段（10/8、172.16/12、192.168/16
 * 等）由中继路由层 isDirectHost 兜底直连（proxy-relay.ts），NO_PROXY 不写无效网段。
 */
const DIRECT_NO_PROXY = [
	"127.0.0.1",
	"localhost",
	"::1",
	".local",
	".internal",
];
export function mergeNoProxy(existing: string | undefined): string {
	const items = new Set(
		(existing ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	for (const h of DIRECT_NO_PROXY) items.add(h);
	return [...items].join(",");
}

/**
 * 应用系统代理到进程环境变量（同时设置大小写，覆盖 undici/Bun fetch 与 curl/wget）。
 * 开启时优先用保存的 httpProxy；为空则从系统（readProxy）兜底读当前系统代理。
 * Bun 的 fetch 与 pi 子进程（继承 env）的 undici EnvHttpProxyAgent 读大写；
 * curl/wget 读小写 http_proxy/https_proxy。
 *
 * 无论开不开代理，env 始终写入本地中继地址（proxy-relay.ts），逻辑统一：
 * - 开代理：中继上游 = effective，每条连接先试上游、不通则直连——
 *   「代理软件中途被关掉」时存量子进程自动回退直连（运行中的进程 env 改不了，
 *   只能靠中继在连接层兜底）；代理恢复后自动切回。
 * - 不开代理：中继上游 = 空，全部直连。
 * 开关代理只需改中继上游，存量/新建子进程 env 都不用变。
 * 中继启动失败时退化：开代理写上游地址（旧行为），不开代理删 env 直连。
 */
export async function applySystemProxy(
	file: string = SETTINGS_FILE,
	readProxy: () => string | Promise<string> = readSystemProxy,
): Promise<void> {
	const { useSystemProxy, httpProxy } = await loadProxySettings(file);
	const effective = useSystemProxy ? httpProxy || (await readProxy()) : "";
	let relayUrl: string | null = null;
	try {
		relayUrl = await ensureProxyRelay(effective);
	} catch (e) {
		console.warn(
			`[proxy] 中继启动失败，退化为旧行为: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	const envProxy = relayUrl ?? effective; // 中继不可用且 effective 为空 → "" → 删 env
	console.log(
		`[proxy] applySystemProxy: 上游=${effective || "(直连)"} → env 代理=${envProxy || "(清空)"}`,
	);
	if (envProxy) {
		process.env.HTTP_PROXY = envProxy;
		process.env.HTTPS_PROXY = envProxy;
		process.env.http_proxy = envProxy;
		process.env.https_proxy = envProxy;
		// 回环/内网地址绕过代理：env 代理指向本地中继，不设 NO_PROXY 时 pi 子进程连
		// 127.0.0.1 的 bridge 或内网服务的请求也走代理链路——上游代理异常时 agent_end 的
		// file-changes 上报会挂住，表现为对话回复完后仍长时间"思考中"。
		const noProxy = mergeNoProxy(process.env.NO_PROXY);
		process.env.NO_PROXY = noProxy;
		process.env.no_proxy = noProxy;
	} else {
		delete process.env.HTTP_PROXY;
		delete process.env.HTTPS_PROXY;
		delete process.env.http_proxy;
		delete process.env.https_proxy;
	}
}

/** 产物分享默认配置（未配置时：无 token + 默认渠道 edgeone + 无自定义域名 + 无 accountId） */
export const SHARE_DEFAULTS = {
	token: "",
	channel: "edgeone" as "edgeone" | "cloudflare",
	customDomain: "",
	accountId: "",
} as const;
export interface ShareSettings {
	token: string;
	channel: "edgeone" | "cloudflare";
	/** 自定义加速域名（可选）；空 = 用项目预设域名 */
	customDomain: string;
	/** Cloudflare Pages 账号 ID（channel=cloudflare 时使用）；空 = 未配置 */
	accountId?: string;
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
		accountId: raw.accountId ?? SHARE_DEFAULTS.accountId,
	};
}

/** 保存产物分享配置（read-modify-write）。token 传空串或缺省（undefined）时保留已保存值：
 * 前端编辑自定义域名等字段时不会把 token 冲掉。 */
export async function saveShareSettings(
	share: ShareSettings,
	file: string = SETTINGS_FILE,
): Promise<ShareSettings> {
	const settings = await readSettingsJson(file);
	const prevToken = settings.share?.token ?? "";
	const next: ShareSettings = {
		token: share.token ? share.token : prevToken,
		channel: share.channel ?? SHARE_DEFAULTS.channel,
		customDomain: share.customDomain ?? SHARE_DEFAULTS.customDomain,
		accountId: share.accountId ?? SHARE_DEFAULTS.accountId,
	};
	settings.share = next;
	await writeSettingsJson(file, settings);
	return next;
}

/**
 * Windows 会话的默认内置工具清单（settings.json.defaultTools）：
 * bash 由 pi >= 0.84.3 的 powershell 工具接管（Windows 自带 PowerShell，零外部依赖；
 * bash 仅在用户自装 Git Bash 时由 pi 引擎自动探测使用，wa-pi 不再下载 PortableGit）。
 */
export const WINDOWS_DEFAULT_TOOLS = [
	"read",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
];

/**
 * macOS / Linux 会话的默认内置工具清单（settings.json.defaultTools）。
 * 背景：pi 引擎的默认激活集只有 read/bash/edit/write，grep/find/ls 虽在注册表
 * 但不激活——wa-pi 的产品语义是内置工具全放行，故用 defaultTools 替换默认
 * 激活集（pi 侧语义：--tools 未传时替换内置默认，不生成硬白名单，扩展/MCP
 * 工具仍全放行，与排除式放行设计兼容）。
 */
export const UNIX_DEFAULT_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
];

/**
 * 旧版（defaultTools 仅做 Windows powershell 平台适配时代）自动写入的清单。
 * 存量升级判断用：磁盘值恰等于此清单 → 视为旧版自动写入而非用户自定义，
 * 启动时升级到当前平台新清单；其他非空值一律视为用户自定义，不覆盖。
 */
export const LEGACY_WINDOWS_DEFAULT_TOOLS = [
	"read",
	"powershell",
	"edit",
	"write",
];

/** 平台对应的默认内置工具清单 */
export function defaultToolsForPlatform(
	platform: string = process.platform,
): string[] {
	return platform === "win32"
		? [...WINDOWS_DEFAULT_TOOLS]
		: [...UNIX_DEFAULT_TOOLS];
}

/**
 * 读取 settings.json.defaultTools（pi 引擎内置工具的初始激活集）。
 * 未配置或格式非法返回 undefined。
 */
export async function loadDefaultTools(
	file: string = SETTINGS_FILE,
): Promise<string[] | undefined> {
	const raw = await readSettingsJson(file);
	const v = raw.defaultTools;
	return Array.isArray(v) && v.every((t) => typeof t === "string")
		? (v as string[])
		: undefined;
}

/** 写入 settings.json.defaultTools（read-modify-write 保留其他字段）。 */
export async function saveDefaultTools(
	tools: string[],
	file: string = SETTINGS_FILE,
): Promise<void> {
	const settings = await readSettingsJson(file);
	settings.defaultTools = tools;
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(settings, null, 2), "utf8");
}

const stringListEquals = (a: string[], b: string[]): boolean =>
	a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * 启动守卫：把 settings.json.defaultTools 对齐到当前平台默认清单。
 * - 未配置 → 写入（written）：新装/从未写过。
 * - 恰为旧版自动写入的清单 → 升级（upgraded）：存量 Windows 老用户补齐 grep/find/ls。
 * - 其他非空值（用户自定义/已是新清单）→ 不动（kept）：尊重手工配置，幂等。
 */
export async function ensureDefaultTools(
	file: string = SETTINGS_FILE,
): Promise<"written" | "upgraded" | "kept"> {
	const current = await loadDefaultTools(file);
	if (current === undefined) {
		await saveDefaultTools(defaultToolsForPlatform(), file);
		return "written";
	}
	if (stringListEquals(current, LEGACY_WINDOWS_DEFAULT_TOOLS)) {
		await saveDefaultTools(defaultToolsForPlatform(), file);
		return "upgraded";
	}
	return "kept";
}
