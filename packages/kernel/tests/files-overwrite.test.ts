import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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

/** 当前环境能否建符号链接（Windows 非开发者模式/非管理员会 EPERM） */
const CAN_SYMLINK = (() => {
	const dir = mkdtempSync(join(tmpdir(), "files-overwrite-symprobe-"));
	try {
		writeFileSync(join(dir, "target"), "x");
		symlinkSync(join(dir, "target"), join(dir, "link"));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
})();

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
	// 实现返回 realpath 口径（防符号链接逃逸）；macOS 的 /var 是 /private/var 的符号链接，
	// 直接拿 mkdtemp 的路径比对会因未解析链接而失败，故按同一口径取真实路径。
	expect(await res!.json()).toEqual({ type: "fs:overwrite", path: await realpath(target) });
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

test("uploads 内的 ../ 穿越路径拒绝写入（403 fs.forbidden）", async () => {
	// 目标就放在项目根：仅当穿越未被拦住才会被改写，断言才有意义
	const target = await seed("notes.png", OLD_BYTES);
	const traversal = `${join(cwd, ".wa-pi", "uploads")}${sep}..${sep}..${sep}notes.png`;
	const res = await makeRouter().handle(
		overwriteRequest(traversal, NEW_BYTES),
	);

	expect(res!.status).toBe(403);
	expect((await res!.json()).failure.code).toBe("fs.forbidden");
	expect(new Uint8Array(await readFile(target))).toEqual(OLD_BYTES);
});

test.skipIf(!CAN_SYMLINK)(
	"uploads 内指向项目外的符号链接拒绝写入（403 fs.forbidden）",
	async () => {
		const outsideDir = await mkdtemp(join(tmpdir(), "files-overwrite-out-"));
		const outside = join(outsideDir, "a.png");
		await writeFile(outside, OLD_BYTES);
		const link = join(cwd, ".wa-pi/uploads/escape.png");
		try {
			await symlink(outside, link);
			const res = await makeRouter().handle(
				overwriteRequest(link, NEW_BYTES),
			);

			expect(res!.status).toBe(403);
			expect((await res!.json()).failure.code).toBe("fs.forbidden");
			expect(new Uint8Array(await readFile(outside))).toEqual(OLD_BYTES);
		} finally {
			await rm(outsideDir, { recursive: true, force: true });
		}
	},
);

test.skipIf(!CAN_SYMLINK)(
	"uploads 内指向项目内非 uploads 文件的符号链接拒绝写入（403 fs.forbidden）",
	async () => {
		const target = await seed("notes.txt", OLD_BYTES);
		const link = join(cwd, ".wa-pi/uploads/inner.png");
		await symlink(target, link);
		const res = await makeRouter().handle(overwriteRequest(link, NEW_BYTES));

		expect(res!.status).toBe(403);
		expect((await res!.json()).failure.code).toBe("fs.forbidden");
		expect(new Uint8Array(await readFile(target))).toEqual(OLD_BYTES);
		const leftovers = (await readdir(join(cwd, ".wa-pi/uploads"))).filter(
			(n) => n.startsWith(".annotate-"),
		);
		expect(leftovers).toEqual([]);
	},
);

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

test.skipIf(!CAN_SYMLINK)(
	"符号链接的扩展名按 realpath 校验（uploads 内 a.png → b.gif 返回 400，不写盘）",
	async () => {
		// 否则只校验请求路径的扩展名：png 字节能写进同目录的 gif 等非白名单文件
		const target = await seed(".wa-pi/uploads/b.gif", OLD_BYTES);
		const link = join(cwd, ".wa-pi/uploads/a.png");
		await symlink(target, link);
		const res = await makeRouter().handle(overwriteRequest(link, NEW_BYTES));

		expect(res!.status).toBe(400);
		expect((await res!.json()).failure.code).toBe("imageAnn.unsupported");
		expect(new Uint8Array(await readFile(target))).toEqual(OLD_BYTES);
	},
);
