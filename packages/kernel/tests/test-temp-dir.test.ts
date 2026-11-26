// 测试隔离目录的生命周期管理（setup.ts 的 helper）。
//
// 背景（2026-11-26）：kernel 测试的全局 preload（tests/setup.ts）用 mkdtemp 建隔离
// WA_PI_DIR，但**从不清理**；`bun test --isolate --parallel=4` 是「每测试文件一个
// worker 进程」，实测 1 文件 = 1 个残留目录，一轮全量 ≈268 个。单目录基准 2MB（占位
// rg/fd 各 1MB），叠加 `$WA_PI_DIR/models` 下每个目录重复下载的 bge-base-zh-v1.5
// （≈98MB），实测 1839 个目录占 4.71GB。
//
// 本文件钉住两件事：
//   1. 谁建的目录谁负责删（外部用 WA_PI_TEST_DIR 指定的固定目录不删）；
//   2. 删临时目录时**不能**顺着 models/bin 的符号链接删掉共享缓存里的真实内容。
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	WA_PI_TEST_DIR_PREFIX,
	cleanupIsolatedWaPiDir,
	createIsolatedWaPiDir,
	hasSharedModel,
	linkSharedAssets,
	prepareSharedAssets,
	seedSharedModels,
	sweepStaleIsolatedDirs,
} from "./helpers/test-temp-dir";

/** 造一个用完即删的临时根（测试自己的夹具，不依赖 setup 的隔离目录） */
function withTempRoot(fn: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "test-temp-dir-fixture-"));
	try {
		fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("createIsolatedWaPiDir", () => {
	test("未指定 WA_PI_TEST_DIR 时新建目录，并标记为自有（可清理）", () => {
		const made: string[] = [];
		try {
			const { dir, owned } = createIsolatedWaPiDir({});
			made.push(dir);
			expect(owned).toBe(true);
			expect(existsSync(dir)).toBe(true);
			expect(dir).toContain("wa-pi-kernel-test-");
		} finally {
			for (const d of made) rmSync(d, { recursive: true, force: true });
		}
	});

	test("指定 WA_PI_TEST_DIR 时直接使用它，且标记为非自有（不许删）", () => {
		withTempRoot((root) => {
			const fixed = join(root, "fixed-dir");
			mkdirSync(fixed, { recursive: true });
			const { dir, owned } = createIsolatedWaPiDir({ WA_PI_TEST_DIR: fixed });
			expect(dir).toBe(fixed);
			expect(owned).toBe(false);
		});
	});
});

describe("cleanupIsolatedWaPiDir", () => {
	test("自有目录被递归删除", () => {
		const { dir } = createIsolatedWaPiDir({});
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(join(dir, "sessions", "s.jsonl"), "{}\n");

		cleanupIsolatedWaPiDir(dir, true);

		expect(existsSync(dir)).toBe(false);
	});

	test("非自有目录（WA_PI_TEST_DIR 指定）原样保留", () => {
		withTempRoot((root) => {
			const fixed = join(root, "fixed-dir");
			mkdirSync(join(fixed, "sessions"), { recursive: true });
			writeFileSync(join(fixed, "sessions", "s.jsonl"), "{}\n");

			cleanupIsolatedWaPiDir(fixed, false);

			expect(existsSync(join(fixed, "sessions", "s.jsonl"))).toBe(true);
		});
	});

	test("目录已不存在时幂等，不抛错", () => {
		const gone = join(tmpdir(), `wa-pi-kernel-test-${process.pid}-gone`);
		expect(() => cleanupIsolatedWaPiDir(gone, true)).not.toThrow();
	});

	test("settleMs：卸载后被异步尾巴重建的目录也会被二次删掉", async () => {
		const { dir } = createIsolatedWaPiDir({});
		mkdirSync(join(dir, "sessions"), { recursive: true });

		// 删完 5ms 后模拟「卸载后仍活着的定时器又把目录建回来」
		// （实测 agent-manager 的 pending 目录就会这样复活）
		setTimeout(() => mkdirSync(join(dir, "pending"), { recursive: true }), 5);
		await cleanupIsolatedWaPiDir(dir, true, { settleMs: 40 });

		expect(existsSync(dir)).toBe(false);
	});
});

describe("共享资产链接", () => {
	test("prepareSharedAssets 建立 models 与 bin 子目录", () => {
		withTempRoot((root) => {
			const shared = prepareSharedAssets(join(root, "shared"));
			expect(existsSync(shared.models)).toBe(true);
			expect(existsSync(shared.bin)).toBe(true);
		});
	});

	test("linkSharedAssets 让 WA_PI_DIR/models 与 bin/rg、bin/fd 都指向共享资产", () => {
		withTempRoot((root) => {
			const shared = prepareSharedAssets(join(root, "shared"));
			writeFileSync(join(shared.bin, "rg"), Buffer.alloc(1_048_576));
			writeFileSync(join(shared.bin, "fd"), Buffer.alloc(1_048_576));

			const { dir } = createIsolatedWaPiDir({});
			try {
				linkSharedAssets(dir, shared);

				expect(lstatSync(join(dir, "models")).isSymbolicLink()).toBe(true);
				expect(lstatSync(join(dir, "bin", "rg")).isSymbolicLink()).toBe(true);
				expect(lstatSync(join(dir, "bin", "fd")).isSymbolicLink()).toBe(true);
				// 链接过去的占位二进制仍满足 tool-binaries 的「体积达标即已存在」判定
				// （它用 statSync 跟链接，见 src/tool-binaries.ts）
				expect(statSync(join(dir, "bin", "rg")).size).toBeGreaterThanOrEqual(1_000_000);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	test("清理临时目录不会顺链接删掉共享缓存里的真实内容", () => {
		withTempRoot((root) => {
			const shared = prepareSharedAssets(join(root, "shared"));
			const modelFile = join(shared.models, "Xenova", "bge-base-zh-v1.5", "config.json");
			mkdirSync(join(shared.models, "Xenova", "bge-base-zh-v1.5"), { recursive: true });
			writeFileSync(modelFile, '{"model":"bge"}');

			const { dir } = createIsolatedWaPiDir({});
			linkSharedAssets(dir, shared);

			cleanupIsolatedWaPiDir(dir, true);

			expect(existsSync(dir)).toBe(false);
			expect(readFileSync(modelFile, "utf8")).toBe('{"model":"bge"}');
		});
	});

	test("linkSharedAssets 幂等：重复调用不抛错", () => {
		withTempRoot((root) => {
			const shared = prepareSharedAssets(join(root, "shared"));
			const { dir } = createIsolatedWaPiDir({});
			try {
				linkSharedAssets(dir, shared);
				expect(() => linkSharedAssets(dir, shared)).not.toThrow();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});

describe("linkSharedAssets 的 models 开关", () => {
	test("models: false 时不接 models 链接（各目录独立下载，避免并发踩同一文件）", () => {
		withTempRoot((root) => {
			const shared = prepareSharedAssets(join(root, "shared"));
			const { dir } = createIsolatedWaPiDir({});
			try {
				linkSharedAssets(dir, shared, { models: false });
				expect(existsSync(join(dir, "models"))).toBe(false);
				// bin 依然接上
				expect(lstatSync(join(dir, "bin", "rg")).isSymbolicLink()).toBe(true);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	test("hasSharedModel 按共享根里有没有 bge 模型判定", () => {
		withTempRoot((root) => {
			const shared = prepareSharedAssets(join(root, "shared"));
			expect(hasSharedModel(shared)).toBe(false);
			mkdirSync(join(shared.models, "Xenova", "bge-base-zh-v1.5"), { recursive: true });
			expect(hasSharedModel(shared)).toBe(true);
		});
	});
});

describe("sweepStaleIsolatedDirs", () => {
	test("只删除超时未动的 wa-pi-kernel-test-* 目录，保留新鲜目录与其他前缀", () => {
		withTempRoot((root) => {
			const stale = join(root, `${WA_PI_TEST_DIR_PREFIX}stale-a`);
			const fresh = join(root, `${WA_PI_TEST_DIR_PREFIX}fresh-b`);
			const other = join(root, "unrelated-dir");
			for (const d of [stale, fresh, other]) mkdirSync(d, { recursive: true });
			// 把 stale 的 mtime 推回 12 小时前（超过 6h 阈值）
			const old = new Date(Date.now() - 12 * 3600 * 1000);
			utimesSync(stale, old, old);

			const removed = sweepStaleIsolatedDirs(root);

			expect(removed).toBe(1);
			expect(existsSync(stale)).toBe(false);
			expect(existsSync(fresh)).toBe(true);
			expect(existsSync(other)).toBe(true);
		});
	});

	test("目录不存在时返回 0 且不抛错", () => {
		expect(() => sweepStaleIsolatedDirs(join(tmpdir(), "no-such-root-xyz"))).not.toThrow();
	});
});

describe("seedSharedModels", () => {
	test("共享缓存为空时从来源目录播种模型文件", () => {
		withTempRoot((root) => {
			const source = join(root, "app-models");
			mkdirSync(join(source, "Xenova", "bge-base-zh-v1.5", "onnx"), { recursive: true });
			writeFileSync(join(source, "Xenova", "bge-base-zh-v1.5", "config.json"), "{}");
			writeFileSync(
				join(source, "Xenova", "bge-base-zh-v1.5", "onnx", "model_quantized.onnx"),
				"weights",
			);

			const shared = prepareSharedAssets(join(root, "shared"));
			const seeded = seedSharedModels(shared, source);

			expect(seeded).toBe(true);
			expect(
				readFileSync(
					join(shared.models, "Xenova", "bge-base-zh-v1.5", "config.json"),
					"utf8",
				),
			).toBe("{}");
		});
	});

	test("共享缓存已有模型时不再播种（不覆盖、不重复拷贝）", () => {
		withTempRoot((root) => {
			const source = join(root, "app-models");
			mkdirSync(join(source, "Xenova", "bge-base-zh-v1.5"), { recursive: true });
			writeFileSync(join(source, "Xenova", "bge-base-zh-v1.5", "config.json"), '{"old":1}');

			const shared = prepareSharedAssets(join(root, "shared"));
			mkdirSync(join(shared.models, "Xenova", "bge-base-zh-v1.5"), { recursive: true });
			writeFileSync(
				join(shared.models, "Xenova", "bge-base-zh-v1.5", "config.json"),
				'{"new":2}',
			);

			expect(seedSharedModels(shared, source)).toBe(false);
			expect(
				readFileSync(
					join(shared.models, "Xenova", "bge-base-zh-v1.5", "config.json"),
					"utf8",
				),
			).toBe('{"new":2}');
		});
	});

	test("来源目录不存在时返回 false 且不抛错（允许后续联网下载）", () => {
		withTempRoot((root) => {
			const shared = prepareSharedAssets(join(root, "shared"));
			expect(seedSharedModels(shared, join(root, "no-such-dir"))).toBe(false);
		});
	});
});
