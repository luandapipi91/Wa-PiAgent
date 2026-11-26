// 测试隔离目录（WA_PI_DIR）与共享资产的创建 / 清理。
//
// 背景（2026-11-26）：setup.ts 用 mkdtemp 建隔离 WA_PI_DIR 却从不清理。kernel 测试以
// `--isolate --parallel=4` 运行 = 每测试文件一个 worker 进程，一轮全量 ≈268 个目录；
// 单目录基准 2MB（占位 rg/fd），且每个目录的 `models/` 会各自重新下载
// bge-base-zh-v1.5（≈98MB）→ 实测 1839 个目录占 4.71GB。
//
// 两处治本：
//   1. 生命周期：本 helper 建的目录登记为「自有」，preload 注册 afterAll 在 worker 退出时
//      递归删除；外部用 WA_PI_TEST_DIR 指定的固定目录不算自有（用户自己管）；
//   2. 共享资产：models/ 与 bin/ 改为指向进程外共享根的符号链接 —— 模型只落盘/下载一次，
//      所有隔离目录复用；删链接不会碰到共享根里的真实文件（rmSync 不跟随符号链接）。
//
// 纯函数式设计（不读全局 env）：便于单测直接钉住行为，setup.ts 负责把 process.env 接进来。
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 隔离 WA_PI_DIR 的目录名前缀（清理脚本按它匹配） */
const ISOLATED_PREFIX = "wa-pi-kernel-test-";

/** 进程外共享根：跨测试进程、跨 worktree 复用同一份 models/bin */
export const SHARED_ASSETS_DIR = join(tmpdir(), "wa-pi-kernel-shared");

/** 共享根里的子目录名 */
const SHARED_MODELS = "models";
const SHARED_BIN = "bin";

export interface IsolatedDir {
	/** 实际使用的 WA_PI_DIR */
	dir: string;
	/** 是否由本进程创建（true 才允许退出时删除） */
	owned: boolean;
}

/**
 * 决定本次进程使用的 WA_PI_DIR。
 * - env.WA_PI_TEST_DIR 显式指定 → 用它，且 owned=false（用户自己管生命周期）；
 * - 否则在系统临时目录下 mkdtemp 新建，owned=true。
 */
export function createIsolatedWaPiDir(env: {
	WA_PI_TEST_DIR?: string | undefined;
}): IsolatedDir {
	const fixed = env.WA_PI_TEST_DIR?.trim();
	if (fixed) {
		mkdirSync(fixed, { recursive: true });
		return { dir: fixed, owned: false };
	}
	const dir = mkdtempSync(join(tmpdir(), ISOLATED_PREFIX));
	return { dir, owned: true };
}

/**
 * 删除自有隔离目录。owned=false（外部指定）或目录已不存在时是空操作。
 *
 * `settleMs > 0` 时返回 Promise：先删，等一段时间再删一次。原因：测试文件自己的
 * afterAll 跑在 preload afterAll **之前**，它们可能在卸载后仍有异步尾巴（定时器 / 回调）
 * 往 WA_PI_DIR 里重新 mkdir（实测 agent-manager 的 pending 目录会被建回来，单个目录就留
 * 下 `<dir>/pending` 这个空壳）。settle 后的二次删除把这种重建也清掉。
 */
export function cleanupIsolatedWaPiDir(
	dir: string,
	owned: boolean,
	options: { settleMs?: number } = {},
): void | Promise<void> {
	if (!owned) return;
	const remove = () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* 清理失败不该让测试结果变红：残留目录由定期清扫兜底 */
		}
	};
	const settleMs = options.settleMs ?? 0;
	if (settleMs <= 0) {
		remove();
		return;
	}
	remove();
	return new Promise<void>((resolve) => {
		setTimeout(() => {
			remove();
			resolve();
		}, settleMs);
	});
}

/** 建立（并返回）共享资产根的 models/bin 子目录 */
export function prepareSharedAssets(root: string = SHARED_ASSETS_DIR): {
	root: string;
	models: string;
	bin: string;
} {
	const models = join(root, SHARED_MODELS);
	const bin = join(root, SHARED_BIN);
	mkdirSync(models, { recursive: true });
	mkdirSync(bin, { recursive: true });
	return { root, models, bin };
}

/**
 * 把共享资产接进隔离目录：`<dir>/bin/{rg,fd}` 与（可选）`<dir>/models` 成为指向共享根的
 * 符号链接。
 *
 * models 用链接的原因：`modelCacheDir()` 返回 `WA_PI_DIR/models`，语义检索类测试会在
 * 新隔离目录里重新下载模型；链接到共享根后只下载一次。
 * bin/rg、bin/fd 用链接的原因：setup 预置的 1MB 占位二进制同样每目录一份。
 *
 * `models: false` 时不接 models（调用方判断共享根里还没有模型时保留各目录独立，
 * 避免多个 worker 并发往同一目录下载同一模型）。
 *
 * 幂等：目标已是符号链接时跳过；目标是真实目录/文件时不动（避免误删测试自己造的东西）。
 * 符号链接失败（权限 / Windows 无权限）时静默降级——届时退化成各目录独立，不影响正确性。
 */
export function linkSharedAssets(
	dir: string,
	shared: ReturnType<typeof prepareSharedAssets> = prepareSharedAssets(),
	options: { models?: boolean } = {},
): void {
	if (options.models ?? true) linkPath(shared.models, join(dir, SHARED_MODELS));
	mkdirSync(join(dir, SHARED_BIN), { recursive: true });
	for (const name of ["rg", "fd"]) {
		const target = join(shared.bin, name);
		// 占位二进制：体积达标即视为「已存在」（见 src/tool-binaries.ts MIN_BINARY_BYTES），
		// 从而测试永远不会触发真实下载。
		if (!existsSync(target)) writePlaceholder(target);
		linkPath(target, join(dir, SHARED_BIN, name));
	}
}

/** 共享根里是否已经有 embedding 模型（没有时 setup 选择不共享 models，见 linkSharedAssets） */
export function hasSharedModel(
	shared: ReturnType<typeof prepareSharedAssets> = prepareSharedAssets(),
): boolean {
	return existsSync(join(shared.models, "Xenova", "bge-base-zh-v1.5"));
}

/** 共享根里的占位二进制体积：1MB（>= tool-binaries 的 1_000_000 阈值） */
const PLACEHOLDER_BYTES = 1_048_576;

function writePlaceholder(path: string): void {
	try {
		writeFileSync(path, Buffer.alloc(PLACEHOLDER_BYTES));
	} catch {
		/* 写不进去就退化成缺二进制（真下载会静默超时，但只是变慢不变错） */
	}
}

/** 仅在目标不存在时建符号链接；已存在（无论链接还是真实文件）一律不动 */
function linkPath(source: string, target: string): void {
	if (existsSync(target)) return;
	try {
		// 链接类型必须与实际源形状一致：Windows 上 dir/file 错配会直接失败
		symlinkSync(source, target, isDir(source) ? "dir" : "file");
	} catch {
		/* 符号链接不可用（权限 / 平台）→ 保持各目录独立，调用方不感知 */
	}
}

function isDir(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * 从「正式应用的模型目录」播种共享根：本机 `~/.pi/agent/models` 通常已有下载好的
 * bge-base-zh-v1.5，拷进共享根后所有测试直接命中，无需联网下载。
 *
 * 只在一个条件成立时播种：共享根里还没有该模型。返回是否真的播种了。
 * 源目录不存在 / 拷贝失败时返回 false——调用方保持「允许联网下载」的原有语义。
 */
export function seedSharedModels(
	shared: ReturnType<typeof prepareSharedAssets> = prepareSharedAssets(),
	sourceModelsDir: string,
): boolean {
	const modelRel = join("Xenova", "bge-base-zh-v1.5");
	if (!existsSync(join(sourceModelsDir, modelRel))) return false;
	if (existsSync(join(shared.models, modelRel))) return false;
	try {
		cpSync(join(sourceModelsDir, "Xenova"), join(shared.models, "Xenova"), {
			recursive: true,
			force: false,
			errorOnExist: false,
		});
		return true;
	} catch {
		return false;
	}
}

/** 供 setup.ts / 清扫脚本复用的前缀常量 */
export const WA_PI_TEST_DIR_PREFIX = ISOLATED_PREFIX;

/** 判定「陈旧」的默认阈值：6 小时。worker 崩死 / 强制中断留下的目录靠它兜底 */
export const STALE_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * 清扫陈旧隔离目录（兜底：worker 被 SIGKILL、断电、调试中断时 afterAll 不会跑）。
 * 只删 `root` 下前缀匹配**且** mtime 超过 maxAgeMs 的目录：跑在跑的测试目录 mtime 很新，
 * 不会被误删。返回删除数量；任何单项失败都被忽略（清扫本身不能把测试搞红）。
 */
export function sweepStaleIsolatedDirs(
	root: string = tmpdir(),
	maxAgeMs: number = STALE_AGE_MS,
): number {
	let removed = 0;
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return 0;
	}
	const deadline = Date.now() - maxAgeMs;
	for (const name of names) {
		if (!name.startsWith(ISOLATED_PREFIX)) continue;
		const target = join(root, name);
		try {
			const st = lstatSync(target);
			if (!st.isDirectory()) continue;
			if (st.mtimeMs > deadline) continue;
			rmSync(target, { recursive: true, force: true });
			removed++;
		} catch {
			/* 单项失败忽略 */
		}
	}
	return removed;
}
