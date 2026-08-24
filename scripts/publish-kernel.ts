// 发布 kernel 二进制动态更新包：把 resources/kernel/ 下的
// WaPiKernel(.exe) + package.json + bun.lock 打成 kernel-<build>.zip，
// 计算 sha256 并生成 kernel-latest.json 清单，上传到 R2（releases/kernel/）。
//
// 上传顺序复用 publish-oss.ts 的「清单最后覆盖」原则：先传 zip + zip.sha256，
// 最后传 kernel-latest.json，防止清单指向尚未上传完成的包。
//
// 用法：R2_ACCESS_KEY_ID=<id> R2_SECRET_ACCESS_KEY=<secret> \
//   bun run scripts/publish-kernel.ts <version> <build> [--target=darwin]
//   （若无 AK/SK，仅打印产物并给出手动上传指引）
import { createHash } from "node:crypto";
import { readFileSync, statSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	S3Client,
	PutObjectCommand,
	CreateMultipartUploadCommand,
	UploadPartCommand,
	CompleteMultipartUploadCommand,
	AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
// 复用 kernel 编译侧的二进制命名逻辑（wa-pi-kernel → WaPiKernel(.exe)，DRY）
import { kernelBinaryName } from "../packages/kernel/scripts/compile-binary";

const REPO_ROOT = join(import.meta.dir, "..");
const KERNEL_DIR = join(REPO_ROOT, "packages", "desktop", "resources", "kernel");

/** 内核内嵌的 bun runtime 版本（kernel 单二进制由 bun --compile 产物充当 bun CLI） */
const KERNEL_VERSION = "1.4.0";

// S3/R2 常量（与 publish-oss.ts 保持一致；kernel 产物单独放 releases/kernel/ 子前缀）
const ENDPOINT =
	"https://8aa0e20f654f0fe3f8ac5f2d6be9da2c.r2.cloudflarestorage.com";
const REGION = "auto"; // R2 固定
const BUCKET = "wapioss";
const PREFIX = "releases/kernel";

/** 平台 → 清单 platform 字符串（win→win32-x64, linux→linux-x64, darwin→darwin-x64） */
export function platformFor(target: "win" | "linux" | "darwin"): string {
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	let os: string;
	if (target === "win") os = "win32";
	else if (target === "linux") os = "linux";
	else os = "darwin";
	return `${os}-${arch}`;
}

/** build 号生成：<YYYYMMDD>-<seq>（time 注入便于测试） */
export function makeBuild(now: Date, seq = 1): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}${m}${d}-${seq}`;
}

/**
 * 组装 zip 内容清单（纯逻辑）：kernel 三件套平铺到 zip 根目录。
 * @param kernelDir resources/kernel 目录
 * @param target 平台（决定二进制后缀，win 为 WaPiKernel.exe）
 */
export function kernelZipEntries(
	kernelDir: string,
	target: "win" | "linux" | "darwin" = "darwin",
): Array<{ src: string; name: string }> {
	const bin = kernelBinaryName(target);
	return [bin, "package.json", "bun.lock"].map((f) => ({
		src: join(kernelDir, f),
		name: f,
	}));
}

/** 生成 kernel-latest.json 清单（返回 JSON 字符串） */
export function buildKernelManifest(opts: {
	version: string;
	build: string;
	kernelVersion: string;
	platform: string;
	fileName: string;
	sha256: string;
	size: number;
	changelog?: string;
}): string {
	return JSON.stringify(
		{
			version: opts.version,
			build: opts.build,
			kernelVersion: opts.kernelVersion,
			platform: opts.platform,
			url: opts.fileName,
			sha256: opts.sha256,
			size: opts.size,
			publishedAt: new Date().toISOString(),
			changelog: opts.changelog || "",
		},
		null,
		2,
	);
}

/** 把 kernel 三件套压成 zip（-j 平铺至根目录），返回 zip 路径 */
function buildZip(
	kernelDir: string,
	target: "win" | "linux" | "darwin",
	build: string,
): string {
	const fileName = `kernel-${build}.zip`;
	const tmpZip = join(mkdtempSync(join(tmpdir(), "kernel-zip-")), fileName);
	const files = kernelZipEntries(kernelDir, target).map((e) => e.src);
	for (const f of files) {
		if (!existsSync(f)) {
			throw new Error(`缺少 kernel 产物：${f}（请先运行 build-kernel-sidecar.ts）`);
		}
	}
	// 用系统 zip（macOS/Linux 自带；Windows 交叉打包在拥有 zip 的环境执行）
	execFileSync("zip", ["-j", tmpZip, ...files], { stdio: "inherit" });
	return tmpZip;
}

/**
 * 手动 multipart 上传大文件（与 publish-oss.ts 同策略，Bun 下 lib-storage 不稳）。
 * 每 part 独立请求 + 失败重试，失败 abort。
 */
async function uploadLarge(
	client: S3Client,
	key: string,
	body: Buffer,
	partSize = 5 * 1024 * 1024,
): Promise<void> {
	const size = body.length;
	console.log(`↑ 分片上传 ${key}（${(size / 1024 / 1024).toFixed(1)} MB）…`);
	const created = await client.send(
		new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key }),
	);
	const uploadId = created.UploadId;
	if (!uploadId) throw new Error("CreateMultipartUpload 未返回 UploadId");
	const partCount = Math.ceil(size / partSize);
	const parts: { PartNumber: number; ETag: string }[] = [];
	try {
		for (let i = 0; i < partCount; i++) {
			const start = i * partSize;
			const end = Math.min(start + partSize, size);
			const partBody = body.subarray(start, end);
			let etag: string | undefined;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					const res = await client.send(
						new UploadPartCommand({
							Bucket: BUCKET,
							Key: key,
							UploadId: uploadId,
							PartNumber: i + 1,
							Body: partBody,
						}),
					);
					etag = res.ETag;
					break;
				} catch {
					if (attempt === 2)
						throw new Error(`part ${i + 1} 上传失败（已重试 3 次）`);
					await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
				}
			}
			if (!etag) throw new Error(`part ${i + 1} 未返回 ETag`);
			parts.push({ PartNumber: i + 1, ETag: etag });
			process.stdout.write(`\r  ${Math.round((end / size) * 100)}%`);
		}
		process.stdout.write("\n");
		await client.send(
			new CompleteMultipartUploadCommand({
				Bucket: BUCKET,
				Key: key,
				UploadId: uploadId,
				MultipartUpload: { Parts: parts },
			}),
		);
		console.log(`✓ 已上传 ${key}`);
	} catch (e) {
		await client
			.send(
				new AbortMultipartUploadCommand({
					Bucket: BUCKET,
					Key: key,
					UploadId: uploadId,
				}),
			)
			.catch(() => {});
		throw e;
	}
}

async function main() {
	// 解析参数：<version> <build> [--target=darwin] [--changelog=...]
	const positionals = process.argv.filter((a) => !a.startsWith("--"));
	const targetArg =
		process.argv.find((a) => a.startsWith("--target="))?.split("=")[1] ||
		"darwin";
	const changelogArg =
		process.argv.find((a) => a.startsWith("--changelog="))?.split("=")[1];
	const version = positionals[2];
	const build = positionals[3] || makeBuild(new Date());
	if (!version) {
		console.error(
			"用法: R2_ACCESS_KEY_ID=<id> R2_SECRET_ACCESS_KEY=<secret> bun run scripts/publish-kernel.ts <version> <build> [--target=darwin]",
		);
		process.exit(1);
	}

	const target = targetArg as "win" | "linux" | "darwin";
	const platform = platformFor(target);
	const fileName = `kernel-${build}.zip`;
	const sha256File = `${fileName}.sha256`;
	const manifestFile = "kernel-latest.json";

	// 1. 打 zip + 计算 sha256/size
	const zipPath = buildZip(KERNEL_DIR, target, build);
	const buf = readFileSync(zipPath);
	const sha256 = createHash("sha256").update(buf).digest("hex");
	const size = statSync(zipPath).size;

	// 2. 生成清单
	const manifest = buildKernelManifest({
		version,
		build,
		kernelVersion: KERNEL_VERSION,
		platform,
		fileName,
		sha256,
		size,
		changelog: changelogArg,
	});

	console.log("Kernel 产物就绪：", { fileName, sha256, size, platform });

	const ak = process.env.R2_ACCESS_KEY_ID;
	const sk = process.env.R2_SECRET_ACCESS_KEY;
	// 无 AK/SK：打印手动上传指引（与 publish-oss.ts 一致）
	if (!ak || !sk) {
		console.log(
			`未提供 R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY，以下产物需要手动上传到 Cloudflare R2：`,
		);
		console.log(`  Bucket: ${BUCKET}（endpoint ${ENDPOINT}，公开读）`);
		console.log(`  - ${zipPath} → ${PREFIX}/${fileName}`);
		console.log(`  - ${sha256} → ${PREFIX}/${sha256File}`);
		console.log(`  - 清单内容 → ${PREFIX}/${manifestFile}`);
		console.log(
			`\n或配置环境变量后重试：R2_ACCESS_KEY_ID=<id> R2_SECRET_ACCESS_KEY=<secret> bun run scripts/publish-kernel.ts ${version} ${build}`,
		);
		process.exit(0);
	}

	const client = new S3Client({
		region: REGION,
		endpoint: ENDPOINT,
		credentials: { accessKeyId: ak, secretAccessKey: sk },
	});

	// 3. 上传：先 zip（大文件分片）→ zip.sha256 → 清单最后覆盖
	await uploadLarge(client, `${PREFIX}/${fileName}`, buf);
	await client.send(
		new PutObjectCommand({
			Bucket: BUCKET,
			Key: `${PREFIX}/${sha256File}`,
			Body: sha256,
		}),
	);
	console.log(`✓ 已上传 ${PREFIX}/${sha256File}`);
	await client.send(
		new PutObjectCommand({
			Bucket: BUCKET,
			Key: `${PREFIX}/${manifestFile}`,
			Body: manifest,
		}),
	);
	console.log(`✓ 已上传 ${PREFIX}/${manifestFile}`);

	console.log(`\n✅ 发布完成: https://oss.wapiagent.top/${PREFIX}/${manifestFile}`);
}

if (import.meta.main) void main();
