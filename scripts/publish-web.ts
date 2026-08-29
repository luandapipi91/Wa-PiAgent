// 官网发布脚本：把 website/ 目录上传到 Cloudflare R2 wapiweb 桶。
//
// 公开访问：wapiweb 已绑定自定义域名 www.wapiagent.top。
// ⚠️ R2 无默认首页机制，根路径 / 会 404，访问需带 /index.html 完整路径。
// 历史：曾双写到 wapioss 的 web/ 前缀（oss.wapiagent.top/web/），
// 2026-08-29 应用户要求移除该渠道并清理对象，现仅上传 wapiweb。
//
// 用法：
//   bun run --env-file=.env scripts/publish-web.ts
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createS3Client } from "./s3-upload.cjs";
import { PutObjectCommand } from "@aws-sdk/client-s3";

const WEB_BUCKET = "wapiweb";
const WEB_PUBLIC_BASE = "https://www.wapiagent.top"; // wapiweb 已绑公开域名（R2 无默认首页，需带 /index.html）
const WEBSITE_DIR = join(import.meta.dir, "..", "website");

/** 按扩展名映射 Content-Type（R2 不推内容协商，HTML 必须显式声明才会内联渲染）。 */
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

export function contentTypeFor(key: string): string {
	const dot = key.lastIndexOf(".");
	if (dot < 0) return "application/octet-stream";
	return (
		CONTENT_TYPES[key.slice(dot).toLowerCase()] ?? "application/octet-stream"
	);
}

/** 递归收集 website/ 下所有文件，key 为相对 website/ 的 POSIX 路径（稳定排序）。 */
export function collectFiles(
	dir: string,
	base = dir,
): { path: string; key: string }[] {
	const out: { path: string; key: string }[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectFiles(full, base));
		} else if (entry.isFile()) {
			out.push({
				path: full,
				key: relative(base, full).split(sep).join("/"),
			});
		}
	}
	out.sort((a, b) => a.key.localeCompare(b.key));
	return out;
}

/** 单个小文件 PUT，失败重试 3 次（与 s3-upload.cjs 的重试节奏一致）。 */
async function putWithRetry(
	client: ReturnType<typeof createS3Client>,
	bucket: string,
	key: string,
	body: Buffer,
): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					Body: body,
					ContentType: contentTypeFor(key),
				}),
			);
			return;
		} catch (e) {
			if (attempt === 2) throw e;
			await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
		}
	}
}

async function main() {
	const accessKeyId = process.env.R2_ACCESS_KEY_ID;
	const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
	if (!accessKeyId || !secretAccessKey) {
		console.log("未检测到 R2 凭证（R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）。");
		console.log(
			"请在 .env 配置后重试：bun run --env-file=.env scripts/publish-web.ts",
		);
		process.exit(0);
	}

	const files = collectFiles(WEBSITE_DIR);
	if (files.length === 0) {
		console.log(`website/ 目录为空（${WEBSITE_DIR}），没有可上传的文件。`);
		process.exit(0);
	}

	const client = createS3Client({ accessKeyId, secretAccessKey });
	console.log(`→ 上传到 ${WEB_BUCKET} 桶…`);
	for (const f of files) {
		await putWithRetry(client, WEB_BUCKET, f.key, readFileSync(f.path));
		console.log(`  ✓ ${f.key}`);
	}

	console.log(`\n✅ 官网发布完成：${WEB_PUBLIC_BASE}/index.html`);
}

if (import.meta.main) {
	void main();
}
