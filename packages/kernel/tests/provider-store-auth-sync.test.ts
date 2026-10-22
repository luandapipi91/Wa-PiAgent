// 测试：ProviderStore 保存/删除 provider 时同步 pi auth.json。
// 背景（2026-08-09 线上问题）：pi 鉴权协议规定凭证存储（auth.json）优先于
// registerProvider 注入的 apiKey，auth.json 残留过期 key 会静默劫持鉴权，
// 导致设置页改 key 不生效。修复 = 遵守 pi 协议，保存时把 key 同步写进 auth.json。
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	readFileSync,
	existsSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderStore } from "../src/provider-store";
import type { ModelProvider } from "@wa-pi/shared";

function makeProvider(overrides: Partial<ModelProvider> = {}): ModelProvider {
	return {
		id: "p1",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		apiKey: "sk-new-key",
		api: "openai-completions",
		models: [{ id: "deepseek-chat", contextWindow: 128000, maxTokens: 4096 }],
		slug: "deepseek",
		...overrides,
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "prov-auth-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function store(): ProviderStore {
	// authFile 不显式传入：应默认落在 providers.json 同目录（auth.json）
	return new ProviderStore(join(dir, "providers.json"));
}

function readAuth(): Record<string, Record<string, unknown>> {
	const p = join(dir, "auth.json");
	return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

test("save 新增 provider → auth.json 按注册 slug 写入 api_key 条目", async () => {
	await store().save(makeProvider());
	const auth = readAuth();
	expect(auth["deepseek"]).toEqual({ type: "api_key", key: "sk-new-key" });
});

test("save 同 id 换 key → auth.json 条目被覆盖为新 key（修复过期 key 劫持场景）", async () => {
	// 模拟线上现场：auth.json 残留旧 key，providers.json 已有该 provider
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({ deepseek: { type: "api_key", key: "sk-old-leaked" } }),
	);
	const s = store();
	await s.save(makeProvider({ apiKey: "sk-old-leaked" }));
	// 用户在设置页改成新 key 保存
	await s.save(makeProvider({ apiKey: "sk-brand-new" }));
	expect(readAuth()["deepseek"]).toEqual({
		type: "api_key",
		key: "sk-brand-new",
	});
});

test("save 不动 auth.json 中其他 provider 条目（含 oauth 登录凭证）", async () => {
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({
			"kimi-coding": {
				type: "oauth",
				access: "acc",
				refresh: "ref",
				expires: 9999999999999,
			},
			other: { type: "api_key", key: "sk-other" },
		}),
	);
	await store().save(makeProvider());
	const auth = readAuth();
	expect(auth["kimi-coding"]).toEqual({
		type: "oauth",
		access: "acc",
		refresh: "ref",
		expires: 9999999999999,
	});
	expect(auth["other"]).toEqual({ type: "api_key", key: "sk-other" });
	expect(auth["deepseek"]).toEqual({ type: "api_key", key: "sk-new-key" });
});

test("save 不覆盖同 slug 的 oauth 条目（避免毁掉 pi CLI /login 的刷新令牌）", async () => {
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({
			deepseek: {
				type: "oauth",
				access: "acc",
				refresh: "ref",
				expires: 9999999999999,
			},
		}),
	);
	await store().save(makeProvider());
	expect(readAuth()["deepseek"].type).toBe("oauth");
});

test("delete → 条目 key 与 provider apiKey 匹配时移除（wa-pi 写入的凭证）", async () => {
	const s = store();
	await s.save(makeProvider());
	expect(readAuth()["deepseek"]).toBeDefined();
	await s.delete("p1");
	expect(readAuth()["deepseek"]).toBeUndefined();
});

test("delete → 条目 key 与 provider apiKey 不匹配时保留（用户自行 login 的凭证）", async () => {
	const s = store();
	await s.save(makeProvider());
	// 用户绕开 wa-pi 用 pi CLI 登录了同 slug 的不同 key
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({ deepseek: { type: "api_key", key: "sk-user-own" } }),
	);
	await s.delete("p1");
	expect(readAuth()["deepseek"]).toEqual({
		type: "api_key",
		key: "sk-user-own",
	});
});

test("delete 不存在的 id → 不动 auth.json", async () => {
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({ deepseek: { type: "api_key", key: "sk-x" } }),
	);
	await store().delete("nonexistent");
	expect(readAuth()["deepseek"]).toEqual({ type: "api_key", key: "sk-x" });
});
