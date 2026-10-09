// 原生依赖（onnxruntime-node / sharp / sqlite-vector 及其平台分包）按目标平台准备，
// 复制到 packages/desktop/resources/native，再由 electron-builder 的 extraResources 原样
// 拷进安装包的 resources/ 下（**在 asar 之外**——原生 .dll/.so/.dylib/.node 无法从 asar 内 dlopen）。
// 模型不在此列：2026-10-09 起改为初始化下载（kernel preloadModel → WA_PI_DIR/models），
// 不再随包内置（见 embedder.ts 与 stageNativeAssets 内注释）。
//
// 为什么需要这一层：
// 1) 这些包的 **JS 被内联进编译产物，原生资产只能从磁盘加载**：
//    - onnxruntime-node 用运行时拼出的相对路径 require ../bin/napi-v6/<plt>/<arch>/onnxruntime_binding.node，
//      内联后该路径落在虚拟 FS 内，原生绑定永远加载不到；
//    - @huggingface/transformers 顶层静态 import sharp，sharp 再按 exports 子路径
//      require('@img/sharp-<plt>-<arch>/sharp.node')，内联后该子路径解析失败 → 整个 transformers
//      加载失败 → 语义检索全线禁用（实测）；
//    - @sqliteai/sqlite-vector 需要平台分包里的 vector.dll/*.so/*.dylib。
//    注意：这里**不是**靠 --external 解决的——kernel/scripts/compile-binary.ts 的
//    EXTERNAL_PACKAGES 只有 ["@napi-rs/keyring"]（本组包一个都没有）；而且实测 --external 在编译
//    产物里形同不可用（bun 只在虚拟根 B:/~BUN/root/ 下解析被 external 的包，cwd/node_modules 与
//    NODE_PATH 都不生效），把这组包标 external 会让产物直接启动崩溃。真实机制见 3) 与 4)。
// 3) bun 编译产物的运行时解析约束（与普通 Node 不同，务必对照本文件写法）：
//    - **解析根是 cwd/node_modules**（不是可执行文件所在目录，实测把 node_modules 放在 exe 旁边
//      解析不到）。宿主以 WA_PI_DIR/runtime 为 cwd 启动 kernel，故资产落在
//      resources/native/node_modules，运行时由 **main.cjs 的 linkNativeAssets** 逐个链接进
//      WA_PI_DIR/runtime/node_modules（见 src/util/runtime-deps.cjs）。本文件只负责把资产按平台摆到
//      resources/native 下。
//      NODE_PATH 不可依赖：它对**包内** require 不生效（实测探针里 require.resolve 命中、真跑
//      kernel 时不命中），全仓库没有一处给它赋值——不要照着旧注释去接 NODE_PATH。
//    - fallback 解析**只认包根下的 index.js/index.cjs/index.mjs**，不读 package.json 的 main
//      （实测 main 指向 dist/ 的包解析失败）→ ensureRootEntry() 给这类包补一个根级入口。
//    另：解析走 realpath → 链接所指向的 **resources/native/node_modules 必须是真实目录**，否则包内
//    相对解析链会断。
// 4) 交叉打包（Mac 上打 Windows 包）时 npm 装的平台分包是**构建机平台**的，不会自动切换：
//    spec §4 要求按 --target 显式准备，这里对缺失的目标平台分包直接报错退出（宁失败不带病出包）。
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PKG = join(import.meta.dir, "..");
const RES = join(PKG, "resources");
const KERNEL_PKG_DIR = join(ROOT, "packages", "kernel");

/** 编译目标 → 原生资产的平台标识 */
export interface NativeTargetSpec {
	/** onnxruntime-node 的 bin/napi-v6/<plat>/<arch> 目录名 */
	ortPlatform: "win32" | "linux" | "darwin";
	ortArch: "x64" | "arm64";
	/** sharp 的平台分包名 */
	sharpPackage: string;
	/** sqlite-vector 的平台分包名 */
	vectorPackage: string;
}

/**
 * 目标平台的原生资产标识。
 * win/linux 固定 x64（electron-builder 只出 x64）；darwin **本机编译**（compile-binary 对 darwin
 * 不传 --target），故随构建机架构（Intel 构建机只能出 x64 包，见 spec §4）。
 */
export function nativeTargetSpec(target: string): NativeTargetSpec {
	if (target === "win") {
		return {
			ortPlatform: "win32",
			ortArch: "x64",
			sharpPackage: "@img/sharp-win32-x64",
			vectorPackage: "@sqliteai/sqlite-vector-win32-x86_64",
		};
	}
	if (target === "linux") {
		return {
			ortPlatform: "linux",
			ortArch: "x64",
			sharpPackage: "@img/sharp-linux-x64",
			vectorPackage: "@sqliteai/sqlite-vector-linux-x86_64",
		};
	}
	if (target === "darwin") {
		const arch = process.arch === "arm64" ? "arm64" : "x64";
		return {
			ortPlatform: "darwin",
			ortArch: arch,
			sharpPackage: `@img/sharp-darwin-${arch}`,
			vectorPackage: `@sqliteai/sqlite-vector-darwin-${arch === "arm64" ? "arm64" : "x86_64"}`,
		};
	}
	throw new Error(
		`[native] 不支持的 target: ${target}（仅 win / linux / darwin）`,
	);
}

/** sqlite-vector 平台分包的扩展名（各平台不同，用于完整性校验与报错） */
export function vectorBinaryName(ortPlatform: string): string {
	if (ortPlatform === "win32") return "vector.dll";
	if (ortPlatform === "linux") return "vector.so";
	return "vector.dylib";
}

//（原「模型完整性护栏 countOnnxFiles」随模型内置方案移除：模型不再随包，无带病出包风险。）

/**
 * ORT 原生绑定护栏：keep 过滤之后 bin/ 下必须还留着 .node 绑定。
 * 过滤条件依赖 bin/napi-v6/<plat>/<arch>/ 这个**版本化目录名**，onnxruntime-node 升级改目录名
 * （napi-v6 → napi-v7…）时过滤命中数会变 0，不拦就会产出一个没有原生绑定的安装包。
 * 参数是 keep 之后保留的相对路径清单——判据与过滤条件本身无关，能独立捕获回归。
 */
export function assertOrtBindingKept(keptRels: string[]): void {
	const bindings = keptRels.filter(
		(r) => r.startsWith("bin/") && r.endsWith(".node"),
	);
	if (bindings.length === 0) {
		throw new Error(
			`[native] onnxruntime-node 的 keep 过滤没有匹配到任何 bin/ 下的 .node 绑定` +
				`（bin/ 命中 ${keptRels.filter((r) => r.startsWith("bin/")).length} 个文件）→ 会产出语义检索不可用的安装包。\n` +
				`  多半是 onnxruntime-node 的 bin/napi-v6/<plat>/<arch>/ 目录名或绑定文件名变了，请核对本文件的 keep 条件。`,
		);
	}
}

/** 用 Node 解析规则定位包的真实目录（不依赖 bun 的 node_modules/.bun 布局细节） */
export function resolvePackageDir(name: string, fromDir: string): string {
	try {
		return dirname(Bun.resolveSync(`${name}/package.json`, fromDir));
	} catch {
		throw new Error(
			`[native] 解析不到包 ${name}（起点 ${fromDir}）。\n` +
				`  交叉打包时目标平台的平台分包不会自动安装，请在目标平台机器上打包，` +
				`或临时安装该平台分包后重试。`,
		);
	}
}

/** 读包根 package.json（缺字段返回空对象） */
async function readPkgJson(dir: string): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
	} catch {
		return {};
	}
}

/** 包的真实入口（package.json 的 main / exports["."]） */
async function entryOf(pkgDir: string): Promise<string> {
	const pkg = await readPkgJson(pkgDir);
	if (typeof pkg.main === "string") return pkg.main;
	const exportsField = pkg.exports as Record<string, unknown> | undefined;
	const dot = exportsField?.["."];
	if (typeof dot === "string") return dot;
	if (dot && typeof dot === "object") {
		for (const key of ["require", "node", "default", "import"]) {
			const v = (dot as Record<string, unknown>)[key];
			if (typeof v === "string") return v;
		}
	}
	return "index.js";
}

/**
 * bun 编译产物的 fallback 解析只认包根 index.*，不读 package.json 的 main：
 * 入口在子目录（dist/…）的包必须补一个根级入口，否则运行时 Cannot find module。
 * 返回补的入口文件名（本来就有根级入口则 null）。只在**目标包**里写，绝不动 node_modules 里的源包。
 */
export async function ensureRootEntry(
	pkgDir: string,
	entryRel: string,
): Promise<string | null> {
	for (const name of ["index.js", "index.cjs", "index.mjs"]) {
		if (existsSync(join(pkgDir, name))) return null;
	}
	const rel = `./${entryRel.replace(/^\.\//, "")}`;
	// stub 自身必须是 CJS 解析。stub 落在**包根**，所以看根 package.json 的 type：
	//   type=module → 用 .cjs（例：onnxruntime-common 根声明 module，入口却是 dist/cjs/index.js）
	//   否则       → .js 即可
	// ESM（.mjs）入口环境里罕见且本依赖集里没有，用 index.mjs 导出转发（保留可用性）。
	const rootType = (await readPkgJson(pkgDir)).type;
	const stub = entryRel.endsWith(".mjs")
		? "index.mjs"
		: rootType === "module"
			? "index.cjs"
			: "index.js";
	await writeFile(
		join(pkgDir, stub),
		stub === "index.mjs"
			? `export * from ${JSON.stringify(rel)};\nexport { default } from ${JSON.stringify(rel)};\n`
			: `// bun --compile 产物的运行时解析只认包根 index.*，本文件是补的入口\nmodule.exports = require(${JSON.stringify(rel)});\n`,
	);
	return stub;
}

/** 递归复制目录，keep 收到相对包根的 POSIX 风格相对路径；返回**被保留文件的相对路径清单**
 *  （调用方据此做完整性护栏：命中 0 即过滤条件已失效）。
 *  注：keep **只对文件生效**——目录一律递归（否则 keep("dist/index.cjs")=true 也会因为
 *  keep("dist")=false 而整棵子目录被丢，实测踩过）。 */
async function copyTree(
	fromDir: string,
	toDir: string,
	keep: (rel: string) => boolean,
): Promise<string[]> {
	const kept: string[] = [];
	const walk = async (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = join(dir, entry.name);
			const rel = relative(fromDir, abs).split("\\").join("/");
			if (entry.isDirectory()) {
				await mkdir(join(toDir, rel), { recursive: true });
				await walk(abs);
			} else if (keep(rel)) {
				await cp(abs, join(toDir, rel));
				kept.push(rel);
			}
		}
	};
	await mkdir(toDir, { recursive: true });
	await walk(fromDir);
	return kept;
}

interface StagedPackage {
	name: string;
	files: number;
	entry: string | null;
	/** keep 之后保留的相对路径清单（护栏用） */
	kept: string[];
}

/** 单个包：按保留清单复制到 <nativeRoot>/node_modules/<name>，必要时补根级入口 */
async function stagePackage(opts: {
	fromDir: string;
	nativeRoot: string;
	name: string;
	keep?: (rel: string) => boolean;
}): Promise<StagedPackage> {
	const toDir = join(opts.nativeRoot, "node_modules", opts.name);
	const kept = await copyTree(opts.fromDir, toDir, opts.keep ?? (() => true));
	const entry = await ensureRootEntry(toDir, await entryOf(opts.fromDir));
	return { name: opts.name, files: kept.length, entry, kept };
}

/** 目录体积（字节；用于打包日志的体积对照，spec §5 预算 ≈58MB/平台） */
export async function dirSize(dir: string): Promise<number> {
	if (!existsSync(dir)) return 0;
	let sum = 0;
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const abs = join(d, e.name);
			if (e.isDirectory()) walk(abs);
			else sum += statSync(abs).size;
		}
	};
	walk(dir);
	return sum;
}

/**
 * 把原生依赖按目标平台复制到 resources/native。
 * 必须在 electron-builder 之前调用（resources/ 已由 buildSidecar 组装完 kernel + web）。
 */
export async function stageNativeAssets(target: "win" | "linux" | "darwin") {
	const spec = nativeTargetSpec(target);
	const nativeRoot = join(RES, "native");

	// 模型不再随包内置（2026-10-09 改为初始化下载）：embedder 无 WA_PI_MODEL_DIR 时
	// 显式把下载缓存落 WA_PI_DIR/models（用户目录持久可写），首启由 kernel 的
	// preloadModel 预热从镜像下载，升级不丢。

	// ---- 原生依赖 ----
	await rm(nativeRoot, { recursive: true, force: true });
	const staged: StagedPackage[] = [];

	// onnxruntime-node：只留目标平台/架构的原生库；win32 去掉 DirectML/dxcompiler/dxil
	//（embedder 固定 device=cpu，DML 用不到，三件套 36MB）
	const ortDir = resolvePackageDir("onnxruntime-node", KERNEL_PKG_DIR);
	const ortBinPrefix = `bin/napi-v6/${spec.ortPlatform}/${spec.ortArch}/`;
	const dmlOnly = ["DirectML.dll", "dxcompiler.dll", "dxil.dll"];
	const ortStaged = await stagePackage({
		fromDir: ortDir,
		nativeRoot,
		name: "onnxruntime-node",
		keep: (rel) =>
			rel === "package.json" ||
			rel === "README.md" ||
			rel.startsWith("dist/") ||
			(rel.startsWith(ortBinPrefix) &&
				!(
					spec.ortPlatform === "win32" &&
					dmlOnly.includes(rel.slice(ortBinPrefix.length))
				)),
	});
	// 护栏：目录名/布局变化时 keep 会命中 0，不拦就会静默发出无原生绑定的包
	assertOrtBindingKept(ortStaged.kept);
	staged.push(ortStaged);
	staged.push(
		await stagePackage({
			fromDir: resolvePackageDir("onnxruntime-common", ortDir),
			nativeRoot,
			name: "onnxruntime-common",
			keep: (rel) => rel === "package.json" || rel.startsWith("dist/"),
		}),
	);

	// sharp + 三个运行时依赖（@img/colour / detect-libc / semver）+ 平台分包
	const sharpDir = resolvePackageDir("sharp", KERNEL_PKG_DIR);
	staged.push(
		await stagePackage({
			fromDir: sharpDir,
			nativeRoot,
			name: "sharp",
			keep: (rel) => rel === "package.json" || rel.startsWith("dist/"),
		}),
	);
	for (const dep of ["@img/colour", "detect-libc", "semver"]) {
		staged.push(
			await stagePackage({
				fromDir: resolvePackageDir(dep, sharpDir),
				nativeRoot,
				name: dep,
			}),
		);
	}
	// sharp 的原生平台分包：lib/ 下的 .node 与 libvips 动态库**同时**放到包根。
	// 运行时有两条寻址路径：bun 编译产物的 fallback 直接找 <pkg>/sharp.node（实测走的这条），
	// sharp 自己的 exports 映射指向 ./lib/*.node（普通 Node 解析）。两条都留着最稳。
	const sharpPlatform = await stagePackage({
		fromDir: resolvePackageDir(spec.sharpPackage, sharpDir),
		nativeRoot,
		name: spec.sharpPackage,
	});
	const sharpPlatformDst = join(nativeRoot, "node_modules", spec.sharpPackage);
	const sharpLibDir = join(sharpPlatformDst, "lib");
	if (existsSync(sharpLibDir)) {
		for (const f of readdirSync(sharpLibDir)) {
			const abs = join(sharpLibDir, f);
			if (statSync(abs).isDirectory()) continue;
			// .node 统一改名 sharp.node（fallback 的寻址名）；动态库保持原名（.node 按原名依赖它）
			await cp(abs, join(sharpPlatformDst, f.endsWith(".node") ? "sharp.node" : f));
		}
	}
	if (!existsSync(join(sharpPlatformDst, "sharp.node"))) {
		throw new Error(
			`[native] ${spec.sharpPackage} 里找不到原生 .node → 会产出语义检索不可用的安装包`,
		);
	}
	staged.push(sharpPlatform);

	// sqlite-vector：主包（纯 JS）+ 平台分包（vector.dll/*.so/*.dylib）
	const vectorDir = resolvePackageDir("@sqliteai/sqlite-vector", KERNEL_PKG_DIR);
	staged.push(
		await stagePackage({
			fromDir: vectorDir,
			nativeRoot,
			name: "@sqliteai/sqlite-vector",
			keep: (rel) =>
				rel === "package.json" ||
				rel === "README.md" ||
				rel.startsWith("dist/"),
		}),
	);
	staged.push(
		await stagePackage({
			fromDir: resolvePackageDir(spec.vectorPackage, vectorDir),
			nativeRoot,
			name: spec.vectorPackage,
		}),
	);
	const vectorBin = join(
		nativeRoot,
		"node_modules",
		spec.vectorPackage,
		vectorBinaryName(spec.ortPlatform),
	);
	if (!existsSync(vectorBin)) {
		throw new Error(
			`[native] ${spec.vectorPackage} 里缺少 ${vectorBinaryName(spec.ortPlatform)} → 会产出语义检索不可用的安装包`,
		);
	}

	// ---- macOS vanilla SQLite dylib：语义检索 setCustomSQLite 必需 ----
	// bun 在 macOS 用 Apple 专有 SQLite（不支持 loadExtension），语义检索需切标准
	// libsqlite3.dylib。dylib 是 build-sqlite-dylib.ts 的编译产物（gitignore，不入库）：
	// 没编译过就报错退出——宁失败不带病出包（否则静默产出「macOS 语义检索不可用」的包）。
	// win/linux 的 bun SQLite 可直接 loadExtension，无需此文件。
	if (spec.ortPlatform === "darwin") {
		const dylibSrc = join(KERNEL_PKG_DIR, "assets", "sqlite", "libsqlite3.dylib");
		if (!existsSync(dylibSrc)) {
			throw new Error(
				`[native] macOS 语义检索需要 ${dylibSrc}（编译产物不入库）\n` +
					`  先跑 bun run scripts/build-sqlite-dylib.ts 生成后再打包`,
			);
		}
		const dylibDir = join(nativeRoot, "node_modules", "wa-pi-sqlite-dylib");
		await mkdir(dylibDir, { recursive: true });
		await cp(dylibSrc, join(dylibDir, "libsqlite3.dylib"));
		staged.push({
			name: "wa-pi-sqlite-dylib",
			files: 1,
			entry: null,
			kept: ["libsqlite3.dylib"],
		});
	}

	const totalMB = (await dirSize(nativeRoot)) / (1024 * 1024);
	console.log(
		`[native] 目标 ${target}（${spec.ortPlatform}/${spec.ortArch}）：` +
			staged
				.map((s) => `${s.name}${s.entry ? `(+${s.entry})` : ""}`)
				.join(" / ") +
			`，合计 ${totalMB.toFixed(1)}MB`,
	);
	return { spec, staged, totalMB };
}
