// kernel-manifest.cjs — 壳/核一致性自检（纯函数，便于测试）。
// 背景（2026-11-15 事故）：NSIS 升级覆盖安装时 WaPiKernel.exe 被旧内核进程锁死，
// 安装器静默跳过未替换 → 壳 0.10.3 / 核 0.10.1 静默共存，内置浏览器 MCP 等内核
// 功能全部缺失且无任何报错。打包时 build-kernel-sidecar.ts 在 kernel 目录落盘
// manifest.json（version=打包时的应用版本 + exe 大小），本模块在应用启动时逐项
// 比对，不一致返回结构化 verdict（供日志与用户弹窗），绝不静默放行。
"use strict";

const { readFileSync, statSync } = require("node:fs");

/**
 * 校验安装包内 kernel 产物与运行中的应用是否一致。
 * 只做 version + 大小两件确定性最强的事：哈希比对启动耗时不可接受，缺失/改写
 * 场景绝大多数反映在大小上（版本内 exe 尺寸恒定，bun --compile 产物无随机性）。
 *
 * @param {object} opts
 * @param {string} opts.manifestPath - resources/kernel/manifest.json 路径
 * @param {string} opts.exePath - resources/kernel/WaPiKernel(.exe) 路径
 * @param {string} opts.appVersion - 运行中应用版本（app.getVersion()）
 * @returns {{ok: true} | {ok: false, reason: "manifest-missing"|"manifest-corrupt"|"version-mismatch"|"exe-missing"|"size-mismatch", expected?: any, actual?: any}}
 */
function checkKernelConsistency({ manifestPath, exePath, appVersion }) {
	// 清单缺失：老版本安装包没有 manifest（首次带清单的版本之前的产物），无法校验
	let raw;
	try {
		raw = readFileSync(manifestPath, "utf8");
	} catch {
		return { ok: false, reason: "manifest-missing" };
	}
	let manifest;
	try {
		manifest = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "manifest-corrupt" };
	}
	// 版本比对：清单 version = 打包时的应用版本。不一致 = 壳/核来自不同次安装
	//（典型：升级时 kernel exe 未被替换 → 壳新核旧）
	if (manifest.version !== appVersion) {
		return {
			ok: false,
			reason: "version-mismatch",
			expected: { version: appVersion },
			actual: { version: manifest.version },
		};
	}
	// exe 存在性
	let st;
	try {
		st = statSync(exePath);
	} catch {
		return {
			ok: false,
			reason: "exe-missing",
			expected: { path: exePath },
			actual: null,
		};
	}
	// 大小比对：版本一致时产物大小恒定；大小不符 = 文件没被替换（升级竞态残留形态）
	if (
		manifest.exe &&
		typeof manifest.exe.size === "number" &&
		st.size !== manifest.exe.size
	) {
		return {
			ok: false,
			reason: "size-mismatch",
			expected: { size: manifest.exe.size },
			actual: { size: st.size },
		};
	}
	return { ok: true };
}

module.exports = { checkKernelConsistency };
