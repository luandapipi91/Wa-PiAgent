import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	listContacts,
	renameContact,
	upsertContact,
} from "../src/contact-store";

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-pi-contact-"));
	file = join(dir, "contacts.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("upsert 新建 person，按 channelId+userId 去重", async () => {
	await upsertContact({ channelId: "ch_a", kind: "person", userId: "u1" }, file);
	await upsertContact({ channelId: "ch_a", kind: "person", userId: "u1" }, file); // 重复
	await upsertContact({ channelId: "ch_a", kind: "person", userId: "u2" }, file);
	const list = await listContacts("ch_a", file);
	expect(list).toHaveLength(2); // u1 去重
	expect(list.map((c) => c.userId).sort()).toEqual(["u1", "u2"]);
});

test("upsert 更新 lastChatAt 但不覆盖 firstChatAt", async () => {
	await upsertContact({ channelId: "ch_a", kind: "person", userId: "u1" }, file);
	const first = (await listContacts("ch_a", file))[0];
	await new Promise((r) => setTimeout(r, 5));
	await upsertContact({ channelId: "ch_a", kind: "person", userId: "u1" }, file);
	const after = (await listContacts("ch_a", file))[0];
	expect(after.firstChatAt).toBe(first.firstChatAt);
	expect(after.lastChatAt).toBeGreaterThan(first.lastChatAt);
});

test("group 与 person 分维度，各自去重", async () => {
	await upsertContact({ channelId: "ch_a", kind: "group", chatId: "g1" }, file);
	await upsertContact({ channelId: "ch_a", kind: "group", chatId: "g1" }, file);
	await upsertContact({ channelId: "ch_a", kind: "group", chatId: "g2" }, file);
	const list = await listContacts("ch_a", file);
	expect(list.filter((c) => c.kind === "group")).toHaveLength(2);
});

test("listContacts 按 channelId 过滤 + lastChatAt 倒序", async () => {
	await upsertContact({ channelId: "ch_a", kind: "person", userId: "u1" }, file);
	await upsertContact({ channelId: "ch_b", kind: "person", userId: "u1" }, file);
	const list = await listContacts("ch_a", file);
	expect(list).toHaveLength(1);
	expect(list[0].channelId).toBe("ch_a");
});

test("renameContact 设置 remark，不存在返回 null", async () => {
	await upsertContact({ channelId: "ch_a", kind: "person", userId: "u1" }, file);
	const c = (await listContacts("ch_a", file))[0];
	const renamed = await renameContact(c.id, "张三", file);
	expect(renamed?.remark).toBe("张三");
	expect(await renameContact("ct_notexist", "x", file)).toBeNull();
});

test("文件损坏/不存在 → 空列表不抛错", async () => {
	await import("node:fs/promises").then((fs) =>
		fs.writeFile(file, "{invalid json", "utf8"),
	);
	await expect(listContacts("ch_a", file)).resolves.toEqual([]);
});
