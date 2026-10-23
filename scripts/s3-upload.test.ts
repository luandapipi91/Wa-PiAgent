import { test, expect } from "bun:test";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { uploadSmall, uploadLarge } = require("./s3-upload.cjs");

// 背景（2026-10-23 线上事故）：同一版本号覆盖发布时，Cloudflare 默认按扩展名缓存
// `.zip`（max-age=14400），而 `.exe`/`.dmg` 不缓存——于是 latest-mac.yml 立刻更新、
// zip 却仍返回 4 小时前的旧对象，客户端下载后 sha512 校验失败
// （「sha512 checksum mismatch」）。根治：上传时统一声明 Cache-Control: no-cache，
// 让 CDN 每次回源校验，覆盖发布立即生效。

function fakeClient() {
	const sent: any[] = [];
	const client = {
		sent,
		async send(cmd: any) {
			sent.push(cmd);
			return { ETag: '"etag-part"', UploadId: "upload-1" };
		},
	};
	return client;
}

const nameOf = (cmd: any) => cmd?.constructor?.name ?? "";

test("uploadSmall：PutObject 带 Cache-Control: no-cache", async () => {
	const client = fakeClient();
	await uploadSmall(client, "releases/latest-mac.yml", Buffer.from("version: 0.7.15"));
	const put = client.sent.find((c) => nameOf(c) === "PutObjectCommand");
	expect(put).toBeTruthy();
	expect(put.input.CacheControl).toBe("no-cache");
});

test("uploadLarge：CreateMultipartUpload 带 Cache-Control: no-cache", async () => {
	const client = fakeClient();
	await uploadLarge(client, "releases/WaPi-Setup-0.7.15.zip", Buffer.alloc(1024));
	const create = client.sent.find((c) => nameOf(c) === "CreateMultipartUploadCommand");
	expect(create).toBeTruthy();
	expect(create.input.CacheControl).toBe("no-cache");
});
