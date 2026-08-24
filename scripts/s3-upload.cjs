// 共用 S3/R2 上传模块（Cloudflare R2，公开读）。
//
// 由 publish-oss.ts 与 publish-kernel.ts 复用，避免两处复制 ~150 行的
// S3Client 创建 + 手动 multipart 分片上传逻辑（DRY）。
//
// 用法：
//   ESM/TS：import { createS3Client, uploadLarge, uploadSmall, BUCKET, ENDPOINT } from "./s3-upload.cjs";
//   CJS：   const { createS3Client, uploadLarge, uploadSmall, BUCKET, ENDPOINT } = require("./s3-upload.cjs");
const {
	S3Client,
	PutObjectCommand,
	CreateMultipartUploadCommand,
	UploadPartCommand,
	CompleteMultipartUploadCommand,
	AbortMultipartUploadCommand,
} = require("@aws-sdk/client-s3");

const ENDPOINT =
	"https://8aa0e20f654f0fe3f8ac5f2d6be9da2c.r2.cloudflarestorage.com";
const REGION = "auto"; // R2 固定
const BUCKET = "wapioss";

/**
 * 创建指向 R2 的 S3Client（endpoint/region 固定）。
 * @param {{ accessKeyId: string, secretAccessKey: string }} credentials
 * @returns {S3Client}
 */
function createS3Client(credentials) {
	return new S3Client({
		region: REGION,
		endpoint: ENDPOINT,
		credentials: {
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
		},
	});
}

/**
 * 手动 multipart 上传大文件：每 part 独立请求 + 失败重试。
 * ⚠️ 不用 @aws-sdk/lib-storage Upload（Bun 下 multipart 流程不稳），
 * 也不用 single PUT（大文件偶发 IncompleteBody）——手动分片最稳。
 * @param {S3Client} client
 * @param {string} key R2 key（含前缀，不含 bucket）
 * @param {Buffer} body 文件全量内容（内部按 partSize 切分）
 * @param {number} [partSize=5*1024*1024] 分片大小
 */
async function uploadLarge(client, key, body, partSize = 5 * 1024 * 1024) {
	const size = body.length;
	console.log(`↑ 分片上传 ${key}（${(size / 1024 / 1024).toFixed(1)} MB）…`);
	const created = await client.send(
		new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key }),
	);
	const uploadId = created.UploadId;
	if (!uploadId) throw new Error("CreateMultipartUpload 未返回 UploadId");
	const partCount = Math.ceil(size / partSize);
	const parts = [];
	try {
		for (let i = 0; i < partCount; i++) {
			const start = i * partSize;
			const end = Math.min(start + partSize, size);
			const partBody = body.subarray(start, end);
			let etag;
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

/**
 * 上传小文件（单次 PUT）：blockmap / sha256 / yml 清单等。
 * Bun 下 createReadStream 流上传会 IncompleteBody，故用 Buffer。
 * @param {S3Client} client
 * @param {string} key R2 key（含前缀，不含 bucket）
 * @param {Buffer|string} body
 */
async function uploadSmall(client, key, body) {
	await client.send(
		new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }),
	);
}

exports.createS3Client = createS3Client;
exports.uploadLarge = uploadLarge;
exports.uploadSmall = uploadSmall;
exports.ENDPOINT = ENDPOINT;
exports.REGION = REGION;
exports.BUCKET = BUCKET;
