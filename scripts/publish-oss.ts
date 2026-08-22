// 发版辅助：把 packages/desktop/release/ 产物上传到 Cloudflare R2（公开读），供 electron-updater 拉取。
// 用法：R2_ACCESS_KEY_ID=<id> R2_SECRET_ACCESS_KEY=<secret> bun run scripts/publish-oss.ts <version> [--no-proxy]
// 产物结构（R2 bucket）：
//   releases/latest.yml                      # 版本清单（固定路径，覆盖式）
//   releases/WaPi-Setup-<version>.exe        # 安装包
//   releases/WaPi-Setup-<version>.exe.blockmap
// releaseNotes：electron-builder 26 不支持 releaseNotesFile，故这里上传前把
// packages/frontend/src/data/version-history.json 第一条内容注入 latest.yml 的 releaseNotes 字段。
import {
	readdirSync,
	readFileSync,
	statSync,
	existsSync,
	createReadStream,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	S3Client,
	PutObjectCommand,
	CreateMultipartUploadCommand,
	UploadPartCommand,
	CompleteMultipartUploadCommand,
	AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";

const ENDPOINT =
	"https://8aa0e20f654f0fe3f8ac5f2d6be9da2c.r2.cloudflarestorage.com";
const REGION = "auto"; // R2 固定
const BUCKET = "wapioss";
const PREFIX = "releases";
const repoRoot = join(import.meta.dir, "..");

interface Artifact {
	path: string;
	/** R2 key（不含 bucket），如 releases/latest.yml */
	key: string;
}

/** 扫 release 目录，挑出 Windows + macOS 平台的更新产物 */
export function listArtifacts(releaseDir: string, version: string): Artifact[] {
	const names = readdirSync(releaseDir);
	const out: Artifact[] = [];
	// electron-updater 按平台读不同清单：Windows 读 latest.yml，macOS 读 latest-mac.yml
	const targets = [
		"latest.yml",
		"latest-mac.yml",
		`WaPi-Setup-${version}.exe`,
		`WaPi-Setup-${version}.exe.blockmap`,
		`WaPi-Setup-${version}.dmg`,
		`WaPi-Setup-${version}.dmg.blockmap`,
		`WaPi-Setup-${version}.zip`,
		`WaPi-Setup-${version}.zip.blockmap`,
	];
	for (const name of names) {
		if (targets.includes(name)) {
			out.push({ path: join(releaseDir, name), key: `${PREFIX}/${name}` });
		}
	}
	return out;
}

/** 从 version-history.json 第一条提取内容，格式化为 releaseNotes 文本 */
function formatReleaseNotes(entry: {
	version: string;
	sections: Record<string, string[]>;
}): string {
	const lines: string[] = [`WA PI Agent ${entry.version} 更新内容：`];
	for (const [category, items] of Object.entries(entry.sections)) {
		lines.push("", `【${category}】`);
		for (const item of items) lines.push(`- ${item}`);
	}
	return lines.join("\n");
}

/** 从 version-history.json 提取最新版本内容注入 latest.yml 的 releaseNotes 字段 */
export function injectReleaseNotes(
	ymlContent: string,
	historyFile: string,
): string {
	let yml = ymlContent;
	if (!existsSync(historyFile)) {
		console.warn(`⚠ 未找到 ${historyFile}，latest.yml 不注入 releaseNotes`);
		return yml;
	}
	let history: unknown;
	try {
		history = JSON.parse(readFileSync(historyFile, "utf8"));
	} catch {
		console.warn(`⚠ ${historyFile} 解析失败，latest.yml 不注入 releaseNotes`);
		return yml;
	}
	if (!Array.isArray(history) || history.length === 0) return yml;
	const notes = formatReleaseNotes(history[0]);
	if (!notes) return yml;
	// latest.yml 是 YAML；releaseNotes 含换行，用 YAML 字面量块（|）最稳。
	const block = `releaseNotes: |-\n${notes
		.split("\n")
		.map((l) => `  ${l}`)
		.join("\n")}\n`;
	if (/^releaseNotes:/m.test(yml)) {
		yml = yml.replace(
			/^releaseNotes:[\s\S]*?(?=\n\S|\n(?![\s\S]))/m,
			block.trimEnd(),
		);
	} else {
		yml = yml.trimEnd() + "\n" + block;
	}
	return yml;
}

/**
 * 手动 multipart 上传大文件：每 part 独立请求 + 失败重试。
 * ⚠️ 不用 @aws-sdk/lib-storage Upload（Bun 下 multipart 流程不稳），
 * 也不用 single PUT（大文件偶发 IncompleteBody）——手动分片最稳。
 */
async function uploadLarge(
	client: S3Client,
	a: Artifact,
	partSize = 5 * 1024 * 1024,
): Promise<void> {
	const size = statSync(a.path).size;
	console.log(`↑ 分片上传 ${a.key}（${(size / 1024 / 1024).toFixed(1)} MB）…`);
	const created = await client.send(
		new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: a.key }),
	);
	const uploadId = created.UploadId;
	if (!uploadId) throw new Error("CreateMultipartUpload 未返回 UploadId");
	const buf = readFileSync(a.path);
	const partCount = Math.ceil(size / partSize);
	const parts: { PartNumber: number; ETag: string }[] = [];
	try {
		for (let i = 0; i < partCount; i++) {
			const start = i * partSize;
			const end = Math.min(start + partSize, size);
			const partBody = buf.subarray(start, end);
			let etag: string | undefined;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					const res = await client.send(
						new UploadPartCommand({
							Bucket: BUCKET,
							Key: a.key,
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
				Key: a.key,
				UploadId: uploadId,
				MultipartUpload: { Parts: parts },
			}),
		);
		console.log(`✓ 已上传 ${a.key}`);
	} catch (e) {
		await client
			.send(
				new AbortMultipartUploadCommand({
					Bucket: BUCKET,
					Key: a.key,
					UploadId: uploadId,
				}),
			)
			.catch(() => {});
		throw e;
	}
}

if (import.meta.main) {
	// 加 --no-proxy 参数：R2 endpoint 在海外，默认保留代理；仅直连场景用 --no-proxy。
	// 注意：@aws-sdk 是静态 import（早于清代理执行），Bun 下脚本内 delete 对已缓存的代理配置
	// 不生效；如需直连，推荐命令行清代理：
	//   HTTPS_PROXY= HTTP_PROXY= https_proxy= http_proxy= bun run --env-file=.env scripts/publish-oss.ts <version>
	const { values: cliArgs, positionals } = parseArgs({
		options: { "no-proxy": { type: "boolean" } },
		allowPositionals: true,
	});
	if (cliArgs["no-proxy"]) {
		delete process.env.HTTPS_PROXY;
		delete process.env.HTTP_PROXY;
		delete process.env.https_proxy;
		delete process.env.http_proxy;
	}

	const version = positionals[0];
	if (!version) {
		console.error(
			"用法: R2_ACCESS_KEY_ID=<id> R2_SECRET_ACCESS_KEY=<secret> bun run scripts/publish-oss.ts <version> [--no-proxy]",
		);
		process.exit(1);
	}

	const ak = process.env.R2_ACCESS_KEY_ID;
	const sk = process.env.R2_SECRET_ACCESS_KEY;
	const releaseDir = join(repoRoot, "packages", "desktop", "release");
	const historyFile = join(
		repoRoot,
		"packages",
		"frontend",
		"src",
		"data",
		"version-history.json",
	);

	// 无 AK/SK：打印手动上传指引
	if (!ak || !sk) {
		const artifacts = listArtifacts(releaseDir, version);
		console.log(
			"未提供 R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY，以下产物需要手动上传到 Cloudflare R2：",
		);
		console.log(`  Bucket: ${BUCKET}（endpoint ${ENDPOINT}，公开读）`);
		for (const a of artifacts) console.log(`  - ${a.path} → ${a.key}`);
		console.log(
			`\n或配置环境变量后重试：R2_ACCESS_KEY_ID=<id> R2_SECRET_ACCESS_KEY=<secret> bun run scripts/publish-oss.ts ${version}`,
		);
		process.exit(0);
	}

	async function main() {
		const artifacts = listArtifacts(releaseDir, version);
		if (artifacts.length === 0) {
			console.error(`release 目录未找到版本 ${version} 的产物：${releaseDir}`);
			process.exit(1);
		}
		const hasLatestYml = artifacts.some(
			(a) => a.key.endsWith("latest.yml") || a.key.endsWith("latest-mac.yml"),
		);
		if (!hasLatestYml) {
			console.error(
				"release 目录缺少 latest.yml / latest-mac.yml（需先在 electron-builder.yml 配 publish 后重新打包）",
			);
			process.exit(1);
		}

		const client = new S3Client({
			region: REGION,
			endpoint: ENDPOINT,
			// ak/sk 已在外层无凭证分支校验（exit 0），此处非空断言收窄类型
			credentials: { accessKeyId: ak!, secretAccessKey: sk! },
		});

		for (const a of artifacts) {
			if (
				a.key.endsWith(".exe") ||
				a.key.endsWith(".dmg") ||
				a.key.endsWith(".zip")
			) {
				// 安装包较大：手动 multipart 分片（每 part 独立请求 + 失败重试）。
				// ⚠️ 不用 @aws-sdk/lib-storage Upload（Bun 下 multipart 流程不稳）
				// 也不用 single PUT（大文件偶发 IncompleteBody）——手动分片最稳。
				// partSize 100MB：R2 直连带宽慢（国内 ~0.1-0.4MB/s），小分片（5MB×30）
				// RTT 开销占比过高（每片 ~15s），大分片显著减少请求次数与总耗时。
				await uploadLarge(client, a, 100 * 1024 * 1024);
			} else if (a.key.endsWith(".yml")) {
				// latest.yml / latest-mac.yml：注入 releaseNotes 后上传
				const body = injectReleaseNotes(readFileSync(a.path, "utf8"), historyFile);
				await client.send(
					new PutObjectCommand({ Bucket: BUCKET, Key: a.key, Body: body }),
				);
				console.log(`✓ 已上传 ${a.key}（已注入 releaseNotes）`);
			} else {
				// blockmap 等小文件：Buffer 上传（Bun 下 createReadStream 流上传会 IncompleteBody）
				await client.send(
					new PutObjectCommand({
						Bucket: BUCKET,
						Key: a.key,
						Body: readFileSync(a.path),
					}),
				);
				console.log(`✓ 已上传 ${a.key}`);
			}
		}

		console.log(
			`\n✅ 发布完成: https://oss.wapiagent.top/${PREFIX}/latest.yml`,
		);
	}

	void main();
}
