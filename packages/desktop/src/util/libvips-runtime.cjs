// sharp 的 libvips 平台分包运行时兜底（darwin 专用）。
//
// 背景：sharp 0.34+ 把 libvips 动态库拆进独立分包 @img/sharp-libvips-darwin-<arch>，
// sharp.node 经 @rpath/libvips-cpp.<ver>.dylib 引用它。@rpath 候选覆盖 npm/pnpm/yarn/bun
// 各家布局，唯独不覆盖「安装包 resources/native/node_modules/@img/ 并排」布局（实测
// dlopen 的 tried 列表六条候选全 no such file）——历史 macOS 安装包未携带该分包时，
// sharp 整链加载失败 → transformers 的 reranker 加载失败 → 知识库深度重排显示「模型不可用」。
//
// 为什么走 DYLD_FALLBACK_LIBRARY_PATH：安装包目录（/Applications 下）不可写，无法把
// libvips 补进 rpath 候选位置；而 dyld 在 rpath 全 miss 后会搜索 DYLD_FALLBACK_LIBRARY_PATH
// （实测：仅含 sharp-darwin-x64 的隔离目录 + 该变量指向 libvips 的 lib/ → sharp.node 加载成功）。
// 故兜底方案：从 npmmirror 下载分包 tarball，解压到 WA_PI_DIR/runtime/native/sharp-libvips/<版本>/，
// kernel-sidecar 把 <目录>/lib 注入 DYLD_FALLBACK_LIBRARY_PATH 后再 spawn kernel。
// win32 分包自带 dll，无需此机制；linux 桌面不分发，不做。
//
// 调用时序（main.cjs）：linkNativeAssets 之后、startSidecar 之前 await 本模块 ensureLibvipsRuntime，
// 下载失败只告警不阻断启动（kernel 侧行为与现状一致：深度重排不可用，下次启动重试）。
const { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } =
	require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const NPM_MIRROR = "https://registry.npmmirror.com";

/**
 * 从包内 sharp 的 optionalDependencies 解析 libvips 分包名/版本/tarball URL。
 * 非 darwin（win32 自带 dll；linux 不分发）、包内缺 sharp、缺对应分包条目 → null。
 */
function resolveLibvipsSpec({ sharpDir, platform, arch }) {
	if (platform !== "darwin") return null;
	let sharp;
	try {
		sharp = JSON.parse(readFileSync(join(sharpDir, "package.json"), "utf8"));
	} catch {
		return null;
	}
	const pkgName = `@img/sharp-libvips-darwin-${arch === "arm64" ? "arm64" : "x64"}`;
	const version = sharp?.optionalDependencies?.[pkgName];
	if (!version) return null;
	const base = pkgName.split("/").pop(); // sharp-libvips-darwin-x64
	return {
		pkgName,
		version,
		tarballUrl: `${NPM_MIRROR}/${pkgName}/-/${base}-${version}.tgz`,
	};
}

/** lib/ 目录下是否已解压出动态库 */
function hasDylib(libDir) {
	if (!existsSync(libDir)) return false;
	try {
		return readdirSync(libDir).some((f) => f.endsWith(".dylib"));
	} catch {
		return false;
	}
}

/** 包内是否已携带 libvips 分包（lib/ 下有动态库）——已带则无需下载注入。 */
function isLibvipsStaged({ nativeNodeModules, pkgName }) {
	return hasDylib(join(nativeNodeModules, ...pkgName.split("/"), "lib"));
}

/**
 * 主流程：确保 libvips 分包可用，返回其 lib 目录（供 sidecar 注入 env）。
 * action：
 *   staged     包内已携带，无需兜底（libDir null）
 *   cached     runtime 下已有下载缓存，直接复用
 *   downloaded 本次下载解压完成
 *   failed     下载/解压失败（残留清理，libDir null；下次启动重试）
 *   unsupported 平台不适用（libDir null）
 * 失败一律不抛——调用方（main.cjs 启动链）只告警，不得阻断启动。
 */
async function ensureLibvipsRuntime({
	nativeNodeModules,
	runtimeDir,
	log,
	platform = process.platform,
	arch = process.arch,
	fetchImpl = globalThis.fetch,
	timeoutMs = 30000,
}) {
	const sharpDir = join(nativeNodeModules, "sharp");
	const spec = resolveLibvipsSpec({ sharpDir, platform, arch });
	if (!spec) return { libDir: null, action: "unsupported" };
	if (isLibvipsStaged({ nativeNodeModules, pkgName: spec.pkgName })) {
		return { libDir: null, action: "staged" };
	}
	const verDir = join(runtimeDir, "native", "sharp-libvips", spec.version);
	const libDir = join(verDir, "lib");
	if (hasDylib(libDir)) return { libDir, action: "cached" };
	try {
		log.info?.(
			`[libvips] 包内未携带 ${spec.pkgName}@${spec.version}，开始下载兜底`,
		);
		const res = await fetchImpl(spec.tarballUrl, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const buf = Buffer.from(await res.arrayBuffer());
		mkdirSync(verDir, { recursive: true });
		// tgz 放版本目录外（sharp-libvips/ 下），解压后立即删除；进程中途被杀留下的
		// 残片会在下次启动被「hasDylib=false → 重新下载覆盖写」自愈。
		const tgz = join(
			runtimeDir,
			"native",
			"sharp-libvips",
			`.tmp-${spec.version}.tgz`,
		);
		writeFileSync(tgz, buf);
		const r = spawnSync("tar", [
			"-xzf",
			tgz,
			"-C",
			verDir,
			"--strip-components",
			"1",
		]);
		rmSync(tgz, { force: true });
		if (r.status !== 0) {
			throw new Error(`tar 解压失败: ${String(r.stderr)}`);
		}
		if (!hasDylib(libDir)) {
			throw new Error("解压后 lib/ 下没有动态库");
		}
		log.info?.(`[libvips] 下载解压完成 → ${libDir}`);
		return { libDir, action: "downloaded" };
	} catch (e) {
		log.error?.(
			`[libvips] 兜底下载失败（深度重排维持不可用，下次启动重试）`,
			e,
		);
		rmSync(verDir, { recursive: true, force: true });
		return { libDir: null, action: "failed" };
	}
}

/** sidecar env 补丁：lib 目录有效 → DYLD_FALLBACK_LIBRARY_PATH；否则空（不注入）。 */
function buildLibvipsEnv(libDir) {
	if (!libDir) return {};
	return { DYLD_FALLBACK_LIBRARY_PATH: libDir };
}

module.exports = {
	resolveLibvipsSpec,
	isLibvipsStaged,
	ensureLibvipsRuntime,
	buildLibvipsEnv,
};
