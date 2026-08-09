import { describe, test, expect, afterEach } from "bun:test";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTrashSettings, saveTrashSettings, TRASH_DEFAULTS } from "../settings-store";

// 与 project-store-trash.test.ts 一致：直接传 TEST_FILE 隔离路径，避免触碰真实
// settings.json（WA_PI_DIR 在模块加载时已快照，设 process.env 无效）。
const TEST_FILE = join(tmpdir(), `test-settings-trash-${Date.now()}.json`);

describe("Trash settings", () => {
	afterEach(async () => {
		await rm(TEST_FILE, { force: true });
	});

	test("loadTrashSettings returns defaults when no file", async () => {
		const settings = await loadTrashSettings(TEST_FILE);
		expect(settings).toEqual(TRASH_DEFAULTS);
	});

	test("saveTrashSettings persists and loadTrashSettings reads back", async () => {
		const custom = {
			autoArchiveEnabled: false,
			autoArchiveDays: 14,
			autoPurgeEnabled: true,
			autoPurgeDays: 60,
		};
		await saveTrashSettings(custom, TEST_FILE);
		const loaded = await loadTrashSettings(TEST_FILE);
		expect(loaded).toEqual(custom);
	});

	test("saveTrashSettings preserves other settings.json fields", async () => {
		// 先写入一个 retry 字段
		await mkdir(join(tmpdir(), "."), { recursive: true });
		await writeFile(TEST_FILE, JSON.stringify({ retry: { maxRetries: 5 } }), "utf8");
		// 保存 trash 设置（read-modify-write，应保留 retry）
		await saveTrashSettings(TRASH_DEFAULTS, TEST_FILE);
		// 验证 retry 字段仍然存在，trash 已写入
		const raw = JSON.parse(await readFile(TEST_FILE, "utf8"));
		expect(raw.retry).toEqual({ maxRetries: 5 });
		expect(raw.trash).toBeDefined();
	});
});
