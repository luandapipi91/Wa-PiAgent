import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { CONTACTS_FILE, type ContactEntity } from "@wa-pi/shared";

async function readJson<T>(file: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return fallback; // 文件不存在/损坏 → 回退，不抛错
	}
}

async function writeJson(file: string, data: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
	await rename(tmp, file); // 同目录 rename 原子，崩溃最多残留 .tmp，不破坏正式文件
}

// 进程内 per-file 串行队列：避免并发 read-modify-write 丢更新
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(file: string, task: () => Promise<T>): Promise<T> {
	const prev = queues.get(file) ?? Promise.resolve();
	const run = prev.then(task, task); // 前一个无论成败都继续下一个
	queues.set(
		file,
		run.then(
			() => {},
			() => {},
		),
	); // 队列自身吞掉错误，避免污染后续任务
	return run;
}

/** 去重键：person 按 channelId+userId；group 按 channelId+chatId */
function dedupKey(
	c: Pick<ContactEntity, "channelId" | "kind" | "userId" | "chatId">,
): string {
	return c.kind === "group"
		? `${c.channelId}:group:${c.chatId}`
		: `${c.channelId}:person:${c.userId}`;
}

/** 某机器人的通讯录（channelId 空 = 全部），按 lastChatAt 倒序 */
export async function listContacts(
	channelId?: string,
	file: string = CONTACTS_FILE,
): Promise<ContactEntity[]> {
	const raw = await readJson<{ contacts?: ContactEntity[] }>(file, {});
	const list = Array.isArray(raw.contacts) ? raw.contacts : [];
	return list
		.filter((c) => !channelId || c.channelId === channelId)
		.sort((a, b) => b.lastChatAt - a.lastChatAt);
}

export type ContactUpsertInput =
	| { channelId: string; kind: "person"; userId: string }
	| { channelId: string; kind: "group"; chatId: string };

/** 新增或更新（去重键命中则更新 lastChatAt，否则新建带 firstChatAt） */
export async function upsertContact(
	input: ContactUpsertInput,
	file: string = CONTACTS_FILE,
): Promise<void> {
	return serialize(file, async () => {
		const raw = await readJson<{ contacts?: ContactEntity[] }>(file, {});
		const contacts = Array.isArray(raw.contacts) ? raw.contacts : [];
		const key = dedupKey(input);
		const now = Date.now();
		const existing = contacts.find((c) => dedupKey(c) === key);
		if (existing) {
			existing.lastChatAt = now;
		} else {
			contacts.push({
				id: `ct_${randomUUID().slice(0, 8)}`,
				channelId: input.channelId,
				kind: input.kind,
				userId: input.kind === "person" ? input.userId : undefined,
				chatId: input.kind === "group" ? input.chatId : undefined,
				firstChatAt: now,
				lastChatAt: now,
			});
		}
		await writeJson(file, { schemaVersion: 1, contacts });
	});
}

/** 确保联系人存在并返回（含 id）：命中返回现有（不动 lastChatAt/remark），未命中创建 */
export async function ensureContact(
	input: ContactUpsertInput,
	file: string = CONTACTS_FILE,
): Promise<ContactEntity> {
	return serialize(file, async () => {
		const raw = await readJson<{ contacts?: ContactEntity[] }>(file, {});
		const contacts = Array.isArray(raw.contacts) ? raw.contacts : [];
		const key = dedupKey(input);
		const existing = contacts.find((c) => dedupKey(c) === key);
		if (existing) return existing;
		const now = Date.now();
		const created: ContactEntity = {
			id: `ct_${randomUUID().slice(0, 8)}`,
			channelId: input.channelId,
			kind: input.kind,
			userId: input.kind === "person" ? input.userId : undefined,
			chatId: input.kind === "group" ? input.chatId : undefined,
			firstChatAt: now,
			lastChatAt: now,
		};
		contacts.push(created);
		await writeJson(file, { schemaVersion: 1, contacts });
		return created;
	});
}

/** 重命名；id 不存在返回 null */
export async function renameContact(
	id: string,
	remark: string,
	file: string = CONTACTS_FILE,
): Promise<ContactEntity | null> {
	return serialize(file, async (): Promise<ContactEntity | null> => {
		const raw = await readJson<{ contacts?: ContactEntity[] }>(file, {});
		const contacts = Array.isArray(raw.contacts) ? raw.contacts : [];
		const c = contacts.find((x) => x.id === id);
		if (!c) return null;
		c.remark = remark;
		await writeJson(file, { schemaVersion: 1, contacts });
		return c;
	});
}
