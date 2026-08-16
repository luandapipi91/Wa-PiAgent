// 发版辅助：把 packages/desktop/release/ 产物上传到阿里云 OSS（公开读），供 electron-updater 拉取。
// 用法：OSS_AK=<AccessKeyId> OSS_SK=<AccessKeySecret> bun run scripts/publish-oss.ts <version>
//
// 产物结构（OSS）：
//   coaicom/releases/latest.yml                      # 版本清单（固定路径，覆盖式）
//   coaicom/releases/WaPi-Setup-<version>.exe        # 安装包
//   coaicom/releases/WaPi-Setup-<version>.exe.blockmap
//
// releaseNotes：electron-builder 26 不支持 releaseNotesFile，故这里上传前把
// packages/desktop/RELEASE_NOTES.md 内容注入 latest.yml 的 releaseNotes 字段。
// 若未提供 OSS_AK/OSS_SK，打印手动上传指引后退出（不失败）。
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error ali-oss 无内置类型声明
import OSS from "ali-oss";

// OSS 是国内节点（oss-cn-heyuan），直连即可；系统代理（Clash 等）对大文件分片上传
// 不稳定，会导致 socket 连接被意外关闭（ali-oss 的 urllib 在代理下上传大 body 失败）。
// 上传前清除代理环境变量，确保直连 OSS。
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
delete process.env.https_proxy;
delete process.env.http_proxy;

const version = process.argv[2];
if (!version) {
	console.error(
		"用法: OSS_AK=<id> OSS_SK=<secret> bun run scripts/publish-oss.ts <version>",
	);
	process.exit(1);
}

const REGION = "oss-cn-heyuan";
const BUCKET = "coaicom";
const PREFIX = "releases";
const ak = process.env.OSS_AK;
const sk = process.env.OSS_SK;
const repoRoot = join(import.meta.dir, "..");
const releaseDir = join(repoRoot, "packages", "desktop", "release");
const historyFile = join(
	repoRoot,
	"packages",
	"frontend",
	"src",
	"data",
	"version-history.json",
);

interface Artifact {
	path: string;
	/** OSS key（不含 bucket），如 releases/latest.yml */
	key: string;
}

/** 扫 release 目录，挑出 Windows + macOS 平台的更新产物 */
function listArtifacts(): Artifact[] {
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
function injectReleaseNotes(ymlPath: string): string {
	let yml = readFileSync(ymlPath, "utf8");
	if (!existsSync(historyFile)) {
		console.warn(`⚠ 未找到 ${historyFile}，latest.yml 不注入 releaseNotes`);
		return yml;
	}
	const history = JSON.parse(readFileSync(historyFile, "utf8"));
	if (!Array.isArray(history) || history.length === 0) return yml;
	const notes = formatReleaseNotes(history[0]);
	if (!notes) return yml;
	// latest.yml 是 YAML；releaseNotes 含换行，用 YAML 字面量块（|）最稳。
	const block = `releaseNotes: |-\n${notes
		.split("\n")
		.map((l) => `  ${l}`)
		.join("\n")}\n`;
	if (/^releaseNotes:/m.test(yml)) {
		yml = yml.replace(/^releaseNotes:[\s\S]*?(?=\n\S|\n$|$)/m, block.trimEnd());
	} else {
		yml = yml.trimEnd() + "\n" + block;
	}
	return yml;
}

// 无 AK/SK：打印手动上传指引
if (!ak || !sk) {
	const artifacts = listArtifacts();
	console.log("未提供 OSS_AK/OSS_SK，以下产物需要手动上传到阿里云 OSS：");
	console.log(`  Bucket: ${BUCKET}（${REGION}，公开读）`);
	for (const a of artifacts) console.log(`  - ${a.path} → ${a.key}`);
	console.log(
		`\n或配置环境变量后重试：OSS_AK=<id> OSS_SK=<secret> bun run scripts/publish-oss.ts ${version}`,
	);
	process.exit(0);
}

async function main() {
	const artifacts = listArtifacts();
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

	const store = new OSS({
		region: REGION,
		accessKeyId: ak,
		accessKeySecret: sk,
		bucket: BUCKET,
		secure: true,
	});
	// 对象级公开读：终端用户通过 GenericProvider 直接 GET，无需签名
	const headers = { "x-oss-object-acl": "public-read" };

	for (const a of artifacts) {
		if (
			a.key.endsWith(".exe") ||
			a.key.endsWith(".dmg") ||
			a.key.endsWith(".zip")
		) {
			// 安装包较大（142~166MB），用分片上传支持进度与断点续传
			const size = statSync(a.path).size;
			console.log(`↑ 分片上传 ${a.key}（${(size / 1024 / 1024).toFixed(1)} MB）…`);
			await store.multipartUpload(a.key, a.path, {
				headers,
				partSize: 5 * 1024 * 1024,
				progress: (p: number) =>
					process.stdout.write(`\r  ${Math.round(p * 100)}%`),
			});
			process.stdout.write("\n");
		} else if (a.key.endsWith(".yml")) {
			// latest.yml / latest-mac.yml：注入 releaseNotes 后上传
			const body = injectReleaseNotes(a.path);
			await store.put(a.key, Buffer.from(body, "utf8"), { headers });
			console.log(`✓ 已上传 ${a.key}（已注入 releaseNotes）`);
		} else {
			// blockmap 等小文件：简单上传
			await store.put(a.key, a.path, { headers });
			console.log(`✓ 已上传 ${a.key}`);
		}
	}

	console.log(
		`\n✅ 发布完成: https://${BUCKET}.${REGION}.aliyuncs.com/${PREFIX}/latest.yml`,
	);
}

void main();
