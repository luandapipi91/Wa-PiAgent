import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpRouter } from "../src/http-router";
import { MAX_OVERWRITE_BYTES, registerFileRoutes } from "../src/routes/files";

let root: string;
let cwd: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "files-overwrite-"));
	cwd = join(root, "project");
	await mkdir(join(cwd, ".wa-pi", "uploads"), { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** 只用到 projectStore.load 的假 store */
function makeRouter(): HttpRouter {
	const router = new HttpRouter();
	const ctx = {
		projectStore: {
			load: async () => ({
				projects: [{ id: "p1", cwd }],
				sessions: [{ id: "s1", projectId: "p1", createdAt: 123 }],
			}),
		},
	};
	registerFileRoutes(router, (async () => new Response()) as any, ctx as any);
	return router;
}

function overwriteRequest(
	path: string,
	bytes: Uint8Array<ArrayBuffer>,
	name = "a.png",
): Request {
	const form = new FormData();
	form.set("file", new File([bytes], name));
	form.set("path", path);
	return new Request("http://x/api/files/overwrite", {
		method: "POST",
		body: form,
	});
}

const OLD_BYTES = new Uint8Array([1, 2, 3, 4]);
const NEW_BYTES = new Uint8Array([9, 9, 9]);

async function seed(rel: string, bytes = OLD_BYTES): Promise<string> {
	const p = join(cwd, rel);
	await mkdir(join(p, ".."), { recursive: true });
	await writeFile(p, bytes);
	return p;
}

test("普通项目 uploads 内图片可覆盖，返回 fs:overwrite", async () => {
	const target = await seed(".wa-pi/uploads/a.png");
	const res = await makeRouter().handle(overwriteRequest(target, NEW_BYTES));

	expect(res).not.toBeNull();
	expect(res!.status).toBe(200);
	expect(await res!.json()).toEqual({ type: "fs:overwrite", path: target });
	expect(new Uint8Array(await readFile(target))).toEqual(NEW_BYTES);
	// 原子写入的临时文件不残留
	expect(await readdir(join(cwd, ".wa-pi/uploads"))).toEqual(["a.png"]);
});

test("默认工作区会话目录（<cwd>/123/...）内图片可覆盖", async () => {
	const target = await seed("123/.wa-pi/uploads/b.png");
	const res = await makeRouter().handle(overwriteRequest(target, NEW_BYTES));

	expect(res!.status).toBe(200);
	expect(new Uint8Array(await readFile(target))).toEqual(NEW_BYTES);
});

test("项目内非 uploads 路径拒绝写入（403 fs.forbidden），内容不变", async () => {
	const target = await seed("notes.txt", NEW_BYTES);
	const res = await makeRouter().handle(
		overwriteRequest(target, OLD_BYTES, "a.png"),
	);

	expect(res!.status).toBe(403);
	expect((await res!.json()).failure.code).toBe("fs.forbidden");
	expect(new Uint8Array(await readFile(target))).toEqual(NEW_BYTES);
});

test("项目外路径拒绝写入（403 fs.forbidden）", async () => {
	const outsideDir = await mkdtemp(join(tmpdir(), "files-overwrite-out-"));
	const outside = join(outsideDir, "a.png");
	await writeFile(outside, OLD_BYTES);
	try {
		const res = await makeRouter().handle(overwriteRequest(outside, NEW_BYTES));
		expect(res!.status).toBe(403);
		expect((await res!.json()).failure.code).toBe("fs.forbidden");
		expect(new Uint8Array(await readFile(outside))).toEqual(OLD_BYTES);
	} finally {
		await rm(outsideDir, { recursive: true, force: true });
	}
});

test("项目内不存在的文件（isPathInProjects → missing）拒绝写入 403", async () => {
	const target = join(cwd, ".wa-pi/uploads/missing.png");
	const res = await makeRouter().handle(overwriteRequest(target, NEW_BYTES));

	expect(res!.status).toBe(403);
	expect((await res!.json()).failure.code).toBe("fs.forbidden");
	// 失败不落盘，也不残留临时文件
	expect(await readdir(join(cwd, ".wa-pi/uploads"))).toEqual([]);
});

test("不支持的扩展名返回 400 imageAnn.unsupported", async () => {
	const target = await seed(".wa-pi/uploads/a.gif");
	const res = await makeRouter().handle(
		overwriteRequest(target, NEW_BYTES, "a.gif"),
	);

	expect(res!.status).toBe(400);
	expect((await res!.json()).failure.code).toBe("imageAnn.unsupported");
	expect(new Uint8Array(await readFile(target))).toEqual(OLD_BYTES);
});

test("缺少 path 字段返回 400", async () => {
	const form = new FormData();
	form.set("file", new File([NEW_BYTES], "a.png"));
	const res = await makeRouter().handle(
		new Request("http://x/api/files/overwrite", { method: "POST", body: form }),
	);

	expect(res!.status).toBe(400);
	expect((await res!.json()).failure.code).toBe("common.missingParam");
});

test("上限常量是 100MB", () => {
	expect(MAX_OVERWRITE_BYTES).toBe(100 * 1024 * 1024);
});

test("超过上限的文件返回 400 attachment.tooLarge 且不写盘", async () => {
	const target = await seed(".wa-pi/uploads/a.png");
	const big = new Uint8Array(MAX_OVERWRITE_BYTES + 1024);
	const res = await makeRouter().handle(overwriteRequest(target, big));

	expect(res!.status).toBe(400);
	expect((await res!.json()).failure.code).toBe("attachment.tooLarge");
	expect(new Uint8Array(await readFile(target))).toEqual(OLD_BYTES);
	expect(await readdir(join(cwd, ".wa-pi/uploads"))).toEqual(["a.png"]);
});
