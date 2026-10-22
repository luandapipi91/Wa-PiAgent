// net-log.ts — 网络请求日志：滚动写文件，不含敏感信息。
//
// 用途：kernel/中继经手的网络请求落盘，供代理/断网类问题事后定位。
// 原则：
// - 不记敏感信息：不记请求头（含 Proxy-Authorization/API Key）、不记 body、
//   URL 去掉 query/hash（部分 provider 用 ?key= 传密钥），只留 scheme://host/path。
// - 滚动：单文件到上限后改名 .1 重开（保留当前 + 1 份历史）。
// - 上限按实际磁盘定：硬顶 50MB，同时不超过空闲空间的 1%（小盘自动收缩），
//   读不到磁盘信息时按 50MB。

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	statfsSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { WA_PI_DIR } from "@wa-pi/shared";

/** 网络请求日志文件路径（~/.pi/agent/logs/network.log） */
export const NET_LOG_FILE = join(WA_PI_DIR, "logs", "network.log");

/** 日志体积硬上限 50MB */
export const NET_LOG_HARD_CAP = 50 * 1024 * 1024;
/** 上限同时不超过空闲磁盘的 1% */
const FREE_DISK_RATIO = 0.01;
/** 小盘兜底下限 1MB */
const NET_LOG_MIN_CAP = 1 * 1024 * 1024;

/** 读目录所在盘的空闲字节数；失败（平台不支持等）返回 undefined */
export function diskFreeBytes(dir: string): number | undefined {
	try {
		const s = statfsSync(dir);
		return s.bavail * s.bsize;
	} catch {
		return undefined;
	}
}

/**
 * 计算日志体积上限：min(50MB, 空闲磁盘 1%)，下限 1MB；
 * 空闲未知（undefined/非正数）时直接用 50MB。
 */
export function resolveNetLogMaxBytes(freeBytes?: number): number {
	if (freeBytes == null || !Number.isFinite(freeBytes) || freeBytes <= 0) {
		return NET_LOG_HARD_CAP;
	}
	return Math.max(
		NET_LOG_MIN_CAP,
		Math.min(NET_LOG_HARD_CAP, Math.floor(freeBytes * FREE_DISK_RATIO)),
	);
}

/**
 * URL 脱敏：去掉 query/hash/userinfo，只留 scheme://host/path。
 * 非 URL（如 CONNECT 的 host:port）原样返回。
 * 注意必须带 "://" 才按 URL 解析——"api.example.com:443" 会被 URL 当成
 * scheme:path 误解析。
 */
export function sanitizeUrlForLog(raw: string): string {
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
	try {
		const u = new URL(raw);
		return `${u.protocol}//${u.host}${u.pathname}`;
	} catch {
		return raw.split(/[?#]/)[0];
	}
}

/** 字节数人性化（日志用）：1023B / 1.5KB / 2.0MB */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 滚动日志写入器：同步追加，到上限改名 .1 重开。写失败静默（日志不影响业务） */
export class NetLogger {
	private size = 0;
	private readonly maxBytes: number;

	constructor(
		private readonly file: string = NET_LOG_FILE,
		maxBytes?: number,
	) {
		this.maxBytes =
			maxBytes ?? resolveNetLogMaxBytes(diskFreeBytes(dirname(file)));
		mkdirSync(dirname(file), { recursive: true });
		try {
			this.size = statSync(file).size;
		} catch {
			this.size = 0;
		}
	}

	log(line: string): void {
		const entry = `${new Date().toISOString()} ${line}\n`;
		const bytes = Buffer.byteLength(entry);
		if (this.size + bytes > this.maxBytes) {
			try {
				if (existsSync(this.file)) renameSync(this.file, `${this.file}.1`);
			} catch {
				/* 改名失败则继续追加 */
			}
			this.size = 0;
		}
		try {
			appendFileSync(this.file, entry);
			this.size += bytes;
		} catch {
			/* 写盘失败静默 */
		}
	}
}

// ---- kernel 进程内单例 ----

let logger: NetLogger | null = null;

/** 取共享 NetLogger（懒创建） */
export function getNetLogger(): NetLogger {
	if (!logger) logger = new NetLogger();
	return logger;
}
