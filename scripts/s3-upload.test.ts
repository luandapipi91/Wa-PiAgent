import { describe, it, expect } from "bun:test";
import {
	createS3Client,
	uploadLarge,
	uploadSmall,
	ENDPOINT,
	BUCKET,
} from "./s3-upload.cjs";

describe("createS3Client", () => {
	it("使用 R2 固定的 endpoint/region 与传入的凭证", async () => {
		const client = createS3Client({ accessKeyId: "AK", secretAccessKey: "SK" });
		const endpoint = await client.config.endpoint?.();
		if (!endpoint) throw new Error("S3 client endpoint 未解析");
		expect(endpoint.hostname).toBe(new URL(ENDPOINT).hostname);
		expect(endpoint.protocol).toBe("https:");
		expect(await client.config.region()).toBe("auto");
		const creds = await client.config.credentials();
		expect(creds.accessKeyId).toBe("AK");
		expect(creds.secretAccessKey).toBe("SK");
	});
});

describe("uploadLarge", () => {
	it("按 create→upload parts→complete 完成多分片上传（携带正确 PartNumber/ETag 序列与 body 切片）", async () => {
		const commands: { name: string; input: any }[] = [];
		const client = {
			async send(cmd: { constructor: { name: string }; input: any }) {
				const name = cmd.constructor.name;
				commands.push({ name, input: cmd.input });
				if (name === "CreateMultipartUploadCommand") return { UploadId: "up-1" };
				if (name === "UploadPartCommand")
					return { ETag: `"etag-${cmd.input.PartNumber}"` };
				if (name === "CompleteMultipartUploadCommand") return {};
				throw new Error(`unexpected command: ${name}`);
			},
		};
		// 12MB 内容，partSize 5MB → 共 3 个 part（5+5+2），验证切分与顺序
		const body = Buffer.alloc(12 * 1024 * 1024, 7);
		await uploadLarge(
			client as any,
			"releases/kernel/kernel-1.zip",
			body,
			5 * 1024 * 1024,
		);

		const names = commands.map((c) => c.name);
		expect(names.slice(0, 1)).toEqual(["CreateMultipartUploadCommand"]);
		expect(names.slice(1, 4)).toEqual([
			"UploadPartCommand",
			"UploadPartCommand",
			"UploadPartCommand",
		]);
		expect(names[4]).toBe("CompleteMultipartUploadCommand");
		// 每个 part 的 body 切片长度与边界字节正确
		expect(commands[1].input.PartNumber).toBe(1);
		expect(commands[1].input.Body.length).toBe(5 * 1024 * 1024);
		expect(commands[2].input.PartNumber).toBe(2);
		expect(commands[2].input.Body.length).toBe(5 * 1024 * 1024);
		expect(commands[3].input.PartNumber).toBe(3);
		expect(commands[3].input.Body.length).toBe(2 * 1024 * 1024);
		expect(commands[3].input.Body[0]).toBe(7);
		// complete 携带按序累积的 parts（PartNumber + ETag）
		expect(commands[4].input.MultipartUpload.Parts).toEqual([
			{ PartNumber: 1, ETag: '"etag-1"' },
			{ PartNumber: 2, ETag: '"etag-2"' },
			{ PartNumber: 3, ETag: '"etag-3"' },
		]);
	});
});

describe("uploadSmall", () => {
	it("发送一次 PutObject，key/body 正确", async () => {
		let sent: { constructor: { name: string }; input: any } | undefined;
		const client = {
			async send(cmd: { constructor: { name: string }; input: any }) {
				sent = cmd;
				return {};
			},
		};
		await uploadSmall(client as any, "releases/latest.yml", Buffer.from("hello"));
		expect(sent?.constructor.name).toBe("PutObjectCommand");
		expect(sent?.input).toEqual({
			Bucket: BUCKET,
			Key: "releases/latest.yml",
			Body: Buffer.from("hello"),
		});
	});
});

// 背景（2026-10-23 线上事故）：同一版本号覆盖发布时，Cloudflare 默认按扩展名缓存
// `.zip`（max-age=14400），而 `.exe`/`.dmg`/`.yml` 不缓存——latest-mac.yml 立刻更新、
// zip 却仍返回 4 小时前的旧对象，客户端下载后 sha512 校验失败。根治：上传统一声明
// Cache-Control: no-cache，让 CDN 每次回源校验，覆盖发布立即生效。
describe("Cache-Control（CDN 缓存治理）", () => {
	const collect = () => {
		const sent: any[] = [];
		const client = {
			async send(cmd: any) {
				sent.push(cmd);
				if (cmd.constructor.name === "CreateMultipartUploadCommand")
					return { UploadId: "up-1" };
				if (cmd.constructor.name === "UploadPartCommand")
					return { ETag: '"etag-1"' };
				return {};
			},
		};
		return { sent, client };
	};

	it("uploadSmall：PutObject 带 CacheControl: no-cache", async () => {
		const { sent, client } = collect();
		await uploadSmall(client as any, "releases/latest-mac.yml", Buffer.from("v: 1"));
		const put = sent.find((c) => c.constructor.name === "PutObjectCommand");
		expect(put.input.CacheControl).toBe("no-cache");
	});

	it("uploadLarge：CreateMultipartUpload 带 CacheControl: no-cache", async () => {
		const { sent, client } = collect();
		await uploadLarge(client as any, "releases/x.zip", Buffer.alloc(1024));
		const create = sent.find(
			(c) => c.constructor.name === "CreateMultipartUploadCommand",
		);
		expect(create.input.CacheControl).toBe("no-cache");
	});
});
