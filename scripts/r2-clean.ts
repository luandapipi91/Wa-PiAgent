// 发版后清理 Cloudflare R2（wapioss 桶）里累积的旧版本安装包。
// 背景：publish-oss 每版上传 exe/dmg/zip + blockmap ≈ 580 MB，从不清理，
// 到 0.10.15 已累积 63 版 31.5 GB。自动更新只依赖 latest*.yml 指向的最新版，
// 旧版本安装包对更新链路没有作用（差量更新只用新版的 blockmap + 新包 Range 请求）。
//
// 用法：
//   bun run --env-file=.env scripts/r2-clean.ts            # 预演（dry-run），只打印将删除的清单
//   bun run --env-file=.env scripts/r2-clean.ts --apply    # 真删
//   bun run --env-file=.env scripts/r2-clean.ts --keep 5   # 保留最近 5 个版本（默认 3）
//
// 安全阀：
//   1. 固定清单 latest.yml / latest-mac.yml / version-history.json 永远保留；
//   2. 无法识别的 key（非本脚本命名规则）不删，归入 skipped 交人工判断；
//   3. 删除前拉线上 latest*.yml，其引用的文件若落在删除清单 → 中止不删。
import { parseArgs } from "node:util";
import {
	DeleteObjectsCommand,
	GetObjectCommand,
	ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createS3Client, BUCKET } from "./s3-upload.cjs";

const RELEASES_PREFIX = "releases/";
/** 更新链路入口与版本历史：覆盖式固定文件，不随版本清理 */
const PROTECTED_KEYS = new Set([
	"releases/latest.yml",
	"releases/latest-mac.yml",
	"releases/version-history.json",
]);
const DEFAULT_KEEP = 3;

export interface R2ObjectLike {
	key: string;
	size: number;
}

export interface CleanupPlan {
	/** 保留的对象 */
	keep: R2ObjectLike[];
	/** 待删除的对象 */
	remove: R2ObjectLike[];
	/** 无法识别的 key，不删 */
	skipped: R2ObjectLike[];
	/** 待删除的总字节数 */
	removeBytes: number;
	/** 保留的版本号（降序） */
	keptVersions: string[];
}

/** 从 R2 key 解析所属版本号；固定清单 / 非安装包命名返回 null */
export function parseVersion(key: string): string | null {
	const m = /^releases\/WaPi-Setup-(\d+\.\d+\.\d+)/.exec(key);
	return m ? m[1] : null;
}

/** 版本号数字比较：0.10.9 > 0.9.5 */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] - pb[i];
	}
	return 0;
}

/**
 * 规划清理：按版本号降序保留最近 keep 个版本的全部产物 + 固定清单，
 * 其余版本进入删除清单；无法识别的 key 不删。
 */
export function planCleanup(objects: R2ObjectLike[], keep: number): CleanupPlan {
	const versions = new Map<string, R2ObjectLike[]>();
	const skipped: R2ObjectLike[] = [];
	for (const o of objects) {
		if (PROTECTED_KEYS.has(o.key)) continue;
		const v = parseVersion(o.key);
		if (!v) {
			skipped.push(o);
			continue;
		}
		const list = versions.get(v) ?? [];
		list.push(o);
		versions.set(v, list);
	}
	const sorted = [...versions.keys()].sort((a, b) => compareVersions(b, a));
	const keptVersions = sorted.slice(0, keep);
	const kept = new Set(keptVersions);
	const remove: R2ObjectLike[] = [];
	for (const v of sorted.slice(keep)) remove.push(...versions.get(v)!);
	// 同版本 hash 重发包（0.7.15-3d632fea）与原包归入同一版本号，上面已合并
	// 保留对象按输入顺序输出，便于人工核对
	const keepList = objects.filter(
		(o) => PROTECTED_KEYS.has(o.key) || (parseVersion(o.key) !== null && kept.has(parseVersion(o.key)!)),
	);
	return {
		keep: keepList,
		remove,
		skipped,
		removeBytes: remove.reduce((n, o) => n + o.size, 0),
		keptVersions,
	};
}

/** 从 latest.yml / latest-mac.yml 文本解析版本号与引用的文件名（不引入 yaml 库） */
export function parseManifest(
	text: string,
): { version: string; files: string[] } | null {
	const version = /^version:\s*(\S+)/m.exec(text)?.[1];
	if (!version) return null;
	const files = new Set<string>();
	for (const re of [/^\s*url:\s*(\S+)/gm, /^path:\s*(\S+)/gm]) {
		for (const m of text.matchAll(re)) files.add(m[1]);
	}
	return { version, files: [...files] };
}

/**
 * 校验删除清单不会误伤线上更新清单引用的文件。
 * 返回冲突描述列表，空数组 = 安全。
 */
export function checkManifestConflicts(
	plan: CleanupPlan,
	manifests: Array<{ version: string; files: string[] }>,
): string[] {
	const removeKeys = new Set(plan.remove.map((o) => o.key));
	const conflicts: string[] = [];
	for (const m of manifests) {
		for (const f of m.files) {
			const key = `${RELEASES_PREFIX}${f}`;
			if (removeKeys.has(key)) {
				conflicts.push(`清单 version=${m.version} 引用的 ${key} 在删除清单中`);
			}
		}
	}
	return conflicts;
}

async function listAll(
	client: ReturnType<typeof createS3Client>,
): Promise<R2ObjectLike[]> {
	const out: R2ObjectLike[] = [];
	let token: string | undefined;
	do {
		const r = await client.send(
			new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }),
		);
		for (const o of r.Contents ?? []) out.push({ key: o.Key!, size: o.Size ?? 0 });
		token = r.IsTruncated ? r.NextContinuationToken : undefined;
	} while (token);
	return out;
}

async function readObject(
	client: ReturnType<typeof createS3Client>,
	key: string,
): Promise<string> {
	const r = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
	return await r.Body!.transformToString();
}

const gb = (n: number) => `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			apply: { type: "boolean" },
			keep: { type: "string", default: String(DEFAULT_KEEP) },
		},
	});
	const keep = Number(values.keep);
	if (!Number.isInteger(keep) || keep < 1) {
		console.error("--keep 必须是 ≥1 的整数");
		process.exit(1);
	}
	const ak = process.env.R2_ACCESS_KEY_ID;
	const sk = process.env.R2_SECRET_ACCESS_KEY;
	if (!ak || !sk) {
		console.error("缺少 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY（用 bun run --env-file=.env）");
		process.exit(1);
	}
	const client = createS3Client({ accessKeyId: ak, secretAccessKey: sk });

	async function main() {
		const objects = await listAll(client);
		const plan = planCleanup(objects, keep);
		const totalBytes = objects.reduce((n, o) => n + o.size, 0);

		console.log(`桶 ${BUCKET}：${objects.length} 个对象 / ${gb(totalBytes)}`);
		console.log(`保留版本：${plan.keptVersions.join(", ")}（共 ${plan.keep.length} 个对象）`);
		console.log(
			`待删除：${plan.remove.length} 个对象 / ${gb(plan.removeBytes)}（${new Set(plan.remove.map((o) => parseVersion(o.key))).size} 个版本）`,
		);
		if (plan.skipped.length) {
			console.warn(`⚠ ${plan.skipped.length} 个无法识别的 key 不处理，请人工确认：`);
			for (const o of plan.skipped) console.warn(`    ${o.key}`);
		}

		// 安全阀：线上清单引用的文件不能在删除清单里
		const manifests = [];
		for (const key of ["releases/latest.yml", "releases/latest-mac.yml"]) {
			try {
				const m = parseManifest(await readObject(client, key));
				if (m) manifests.push(m);
				else console.warn(`⚠ ${key} 解析失败，跳过校验`);
			} catch (err) {
				console.warn(`⚠ 读取 ${key} 失败，跳过校验：${err instanceof Error ? err.message : err}`);
			}
		}
		const conflicts = checkManifestConflicts(plan, manifests);
		if (conflicts.length) {
			console.error("✗ 中止：删除清单与线上更新清单冲突");
			for (const c of conflicts) console.error(`    ${c}`);
			process.exit(1);
		}

		if (!values.apply) {
			console.log("\n（预演模式，未删除任何对象；确认无误后加 --apply 执行）");
			return;
		}

		// DeleteObjects 单次上限 1000 个
		const keys = plan.remove.map((o) => ({ Key: o.key }));
		let deleted = 0;
		for (let i = 0; i < keys.length; i += 1000) {
			const r = await client.send(
				new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.slice(i, i + 1000) } }),
			);
			deleted += r.Deleted?.length ?? 0;
			if (r.Errors?.length) {
				console.error("✗ 部分删除失败：");
				for (const e of r.Errors) console.error(`    ${e.Key}: ${e.Message}`);
				process.exit(1);
			}
		}
		const after = await listAll(client);
		console.log(`\n✅ 已删除 ${deleted} 个对象，桶现余 ${after.length} 个对象 / ${gb(after.reduce((n, o) => n + o.size, 0))}`);
	}

	void main().catch((err) => {
		console.error(err instanceof Error ? err : String(err));
		process.exit(1);
	});
}
