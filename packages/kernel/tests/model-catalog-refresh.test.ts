// model-catalog-refresh 的单元测试（规格：后台拉目录，失败绝不影响系统）
//
// 覆盖四类不变量：
//   1. 解析：服务端三种形状都能认，不支持的类型/无 id 的条目丢掉（与 pi 的 parseCatalog 同语义）；
//   2. 落盘语义：只有目录**真的变了**才写 models-store.json —— 下游靠这个 mtime 判断
//      「要不要重新生成 provider-extension」，多写一次盘就是一次无谓的重生成；
//   3. 失败降级：超时 / 5xx / 畸形 JSON / 盘不可写一律静默，保留旧数据（这是用户最在意的
//      「后台自动拉、不影响系统本身」）；
//   4. 编排：只有 changed 时才调 regenerate，且 regenerate 抛错不外泄。
//
// fetch 与超时信号全部注入（不发真实网络请求、不挂 4 秒定时器）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CATALOG_ATTEMPT_TIMEOUT_MS,
	fetchProviderCatalog,
	modelsStorePath,
	parseCatalogPayload,
	readModelsStore,
	refreshCatalogAndRegenerate,
	refreshModelCatalog,
	writeModelsStore,
} from "../src/model-catalog-refresh.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "catalog-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (tempDirs.length) {
		const dir = tempDirs.pop()!;
		await rm(dir, { recursive: true, force: true });
	}
});

/** 不触发真实定时器的信号（测试里绝不挂 4 秒定时器） */
const noSignal = () => new AbortController().signal;

/** 造一个假 fetch：返回指定响应，并记录请求（URL / 头） */
function fakeFetch(
	respond: (url: URL, init?: RequestInit) => Response | Promise<Response>,
	seen?: Array<{ url: string; headers: Record<string, string> }>,
): typeof fetch {
	return (async (input: any, init?: RequestInit) => {
		const url = input instanceof URL ? input : new URL(String(input));
		seen?.push({
			url: url.href,
			headers: (init?.headers as Record<string, string>) ?? {},
		});
		return respond(url, init);
	}) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json", ...(init.headers ?? {}) },
		...init,
	});
}

describe("parseCatalogPayload（对齐 pi 的 parseCatalog）", () => {
	test("数组 / {models:[]} / 以 id 为键的对象都能认", () => {
		const models = [{ id: "a" }, { id: "b" }];
		expect(parseCatalogPayload("p", models)).toHaveLength(2);
		expect(parseCatalogPayload("p", { models })).toHaveLength(2);
		expect(
			parseCatalogPayload("p", { a: { id: "a" }, b: { id: "b" } }),
		).toHaveLength(2);
	});

	test("补上 provider 字段（下游按 provider 归组）", () => {
		expect(parseCatalogPayload("openrouter", [{ id: "x" }])).toEqual([
			{ id: "x", provider: "openrouter" },
		]);
	});

	test("丢掉无 id 的条目与不支持的类型", () => {
		const out = parseCatalogPayload("p", [
			{ id: "keep" },
			{ name: "no-id" },
			"nope",
			{ id: "audio", type: "audio" },
			{ id: "img", type: "image" },
		]);
		expect(out.map((m: any) => m.id)).toEqual(["keep", "img"]);
	});

	test("形状完全不认识 → 抛错（调用方当本次失败处理）", () => {
		expect(() => parseCatalogPayload("p", "not-a-catalog")).toThrow();
		expect(() => parseCatalogPayload("p", 42)).toThrow();
	});
});

describe("readModelsStore / writeModelsStore", () => {
	test("文件不存在 / 损坏 / 形状非法 → 空表，不抛错", async () => {
		const dir = await tempDir();
		expect(await readModelsStore(dir)).toEqual({});
		await writeFile(modelsStorePath(dir), "{ not json", "utf8");
		expect(await readModelsStore(dir)).toEqual({});
		await writeFile(modelsStorePath(dir), JSON.stringify(["nope"]), "utf8");
		expect(await readModelsStore(dir)).toEqual({});
	});

	test("读回时丢掉形状非法的条目、补齐缺省数值", async () => {
		const dir = await tempDir();
		await writeFile(
			modelsStorePath(dir),
			JSON.stringify({
				good: { models: [{ id: "m" }], checkedAt: 5, lastModified: 7, etag: "e" },
				noModels: { checkedAt: 1 },
				badValue: "x",
			}),
			"utf8",
		);
		const store = await readModelsStore(dir);
		expect(Object.keys(store)).toEqual(["good"]);
		expect(store.good).toEqual({
			models: [{ id: "m" }],
			checkedAt: 5,
			lastModified: 7,
			etag: "e",
		});
	});

	test("写盘成功且不留临时文件（原子替换）", async () => {
		const dir = await tempDir();
		const ok = await writeModelsStore(dir, {
			p: { models: [], checkedAt: 1, lastModified: 0 },
		});
		expect(ok).toBe(true);
		expect(await readModelsStore(dir)).toEqual({
			p: { models: [], checkedAt: 1, lastModified: 0 },
		});
		const leftovers = (await import("node:fs/promises")).readdir(dir);
		expect((await leftovers).filter((f) => f.includes(".tmp-"))).toEqual([]);
	});
});

describe("fetchProviderCatalog（4 秒超时、按状态码分支）", () => {
	test("200：解析目录并带上 lastModified 与 etag", async () => {
		const seen: Array<{ url: string; headers: Record<string, string> }> = [];
		const out = await fetchProviderCatalog("openrouter", {
			timeoutMs: CATALOG_ATTEMPT_TIMEOUT_MS,
			signalImpl: noSignal,
			fetchImpl: fakeFetch(
				() =>
					jsonResponse([{ id: "m", cost: { input: 1 } }], {
						headers: {
							"last-modified": "Wed, 01 Oct 2026 00:00:00 GMT",
							etag: '"abc"',
						},
					}),
				seen,
			),
		});
		expect(out.kind).toBe("ok");
		if (out.kind !== "ok") return;
		expect(out.entry.models).toEqual([
			{ id: "m", cost: { input: 1 }, provider: "openrouter" },
		]);
		expect(out.entry.lastModified).toBe(Date.parse("Wed, 01 Oct 2026 00:00:00 GMT"));
		expect(out.entry.etag).toBe('"abc"');
		// 请求形态：带 provider 路径与 types 参数（上游按它返回全量分片）
		expect(seen[0].url).toContain("/api/models/providers/openrouter");
		expect(seen[0].url).toContain("types=chat%2Cimage%2Cclassifier");
		// 首次拉取不带校验器：缓存为空时带 etag 会让 304 把覆盖层清空
		expect(seen[0].headers["if-none-match"]).toBeUndefined();
	});

	test("304：沿用旧 models，只推进 checkedAt", async () => {
		const prev = {
			models: [{ id: "old", provider: "p" }],
			checkedAt: 1,
			lastModified: 1000,
			etag: '"v1"',
		};
		const seen: Array<{ url: string; headers: Record<string, string> }> = [];
		const out = await fetchProviderCatalog("p", {
			prev,
			signalImpl: noSignal,
			fetchImpl: fakeFetch(() => new Response(null, { status: 304 }), seen),
		});
		expect(out.kind).toBe("ok");
		if (out.kind !== "ok") return;
		expect(out.entry.models).toEqual(prev.models);
		expect(out.entry.lastModified).toBe(1000);
		expect(out.entry.checkedAt).toBeGreaterThan(1);
		// 有缓存体时才带校验器
		expect(seen[0].headers["if-none-match"]).toBe('"v1"');
	});

	test("404/501：记「该 provider 无远程目录」（lastModified=0）", async () => {
		for (const status of [404, 501]) {
			const out = await fetchProviderCatalog("gone", {
				signalImpl: noSignal,
				fetchImpl: fakeFetch(() => new Response(null, { status })),
			});
			expect(out.kind).toBe("absent");
			if (out.kind !== "absent") continue;
			expect(out.entry.lastModified).toBe(0);
			expect(out.entry.models).toEqual([]);
		}
	});

	test("5xx / 畸形 JSON / 网络抛错 / 超时 → error（一律不抛）", async () => {
		const cases: Array<() => Promise<Response>> = [
			async () => new Response(null, { status: 500 }),
			async () => new Response("{ not json", { status: 200 }),
			async () => {
				throw new Error("network down");
			},
			async () => {
				// 模拟 AbortSignal.timeout 到点
				const err = new Error("The operation was aborted");
				err.name = "TimeoutError";
				throw err;
			},
		];
		for (const respond of cases) {
			const out = await fetchProviderCatalog("p", {
				signalImpl: noSignal,
				fetchImpl: fakeFetch(respond),
			});
			expect(out.kind).toBe("error");
		}
	});
});

describe("refreshModelCatalog（只在真变化时落盘）", () => {
	test("首次拉到数据 → 写盘、changed=true", async () => {
		const dir = await tempDir();
		const res = await refreshModelCatalog(["p"], {
			agentDir: dir,
			signalImpl: noSignal,
			fetchImpl: fakeFetch(() =>
				jsonResponse([{ id: "m" }], {
					headers: { "last-modified": "Wed, 01 Oct 2026 00:00:00 GMT" },
				}),
			),
		});
		expect(res.changed).toBe(true);
		expect(res.updated).toEqual(["p"]);
		expect(res.failed).toEqual([]);
		const store = await readModelsStore(dir);
		expect(store.p.models).toHaveLength(1);
	});

	test("第二次拉到相同内容 → 不写盘（mtime 不动，避免无谓重生成）", async () => {
		const dir = await tempDir();
		const same = () =>
			jsonResponse([{ id: "m" }], {
				headers: { "last-modified": "Wed, 01 Oct 2026 00:00:00 GMT" },
			});
		await refreshModelCatalog(["p"], {
			agentDir: dir,
			signalImpl: noSignal,
			fetchImpl: fakeFetch(same),
		});
		const before = (await stat(modelsStorePath(dir))).mtimeMs;
		await new Promise((r) => setTimeout(r, 20));
		const res = await refreshModelCatalog(["p"], {
			agentDir: dir,
			signalImpl: noSignal,
			fetchImpl: fakeFetch(same),
		});
		expect(res.changed).toBe(false);
		expect(res.updated).toEqual([]);
		expect((await stat(modelsStorePath(dir))).mtimeMs).toBe(before);
	});

	test("上游 lastModified 变了 → 认作更新并写盘", async () => {
		const dir = await tempDir();
		const respond = (lm: string) =>
			fakeFetch(() => jsonResponse([{ id: "m" }], { headers: { "last-modified": lm } }));
		await refreshModelCatalog(["p"], {
			agentDir: dir,
			signalImpl: noSignal,
			fetchImpl: respond("Wed, 01 Oct 2026 00:00:00 GMT"),
		});
		const res = await refreshModelCatalog(["p"], {
			agentDir: dir,
			signalImpl: noSignal,
			fetchImpl: respond("Thu, 02 Oct 2026 00:00:00 GMT"),
		});
		expect(res.changed).toBe(true);
		expect(res.updated).toEqual(["p"]);
	});

	test("拉取失败 → 保留旧条目、不写盘、记入 failed", async () => {
		const dir = await tempDir();
		await writeModelsStore(dir, {
			p: { models: [{ id: "kept" }], checkedAt: 1, lastModified: 1234, etag: '"e"' },
		});
		const before = (await stat(modelsStorePath(dir))).mtimeMs;
		const res = await refreshModelCatalog(["p"], {
			agentDir: dir,
			signalImpl: noSignal,
			fetchImpl: fakeFetch(() => new Response(null, { status: 500 })),
		});
		expect(res.changed).toBe(false);
		expect(res.failed).toEqual(["p"]);
		expect((await readModelsStore(dir)).p.models).toEqual([{ id: "kept" }]);
		expect((await stat(modelsStorePath(dir))).mtimeMs).toBe(before);
	});

	test("去重、空清单早返回（不打任何请求）", async () => {
		const dir = await tempDir();
		const seen: unknown[] = [];
		const f = fakeFetch(
			() => jsonResponse([{ id: "m" }]),
			seen as Array<{ url: string; headers: Record<string, string> }>,
		);
		const empty = await refreshModelCatalog([], {
			agentDir: dir,
			signalImpl: noSignal,
			fetchImpl: f,
		});
		expect(empty.changed).toBe(false);
		expect(seen).toHaveLength(0);

		const dup = await refreshModelCatalog(["p", "p", ""], {
			agentDir: dir,
			signalImpl: noSignal,
			fetchImpl: f,
		});
		expect(dup.providerIds).toEqual(["p"]);
		expect(seen).toHaveLength(1);
	});

	test("盘不可写（目录不存在）→ changed=false，不抛错", async () => {
		const res = await refreshModelCatalog(["p"], {
			agentDir: join(tmpdir(), "no-such-dir-xyz", "deep"),
			signalImpl: noSignal,
			fetchImpl: fakeFetch(() => jsonResponse([{ id: "m" }])),
		});
		expect(res.changed).toBe(false);
	});
});

describe("refreshCatalogAndRegenerate（编排：只有变化才重建）", () => {
	test("有变化 → 调 regenerate 一次；日志说明变更了哪些 provider", async () => {
		const dir = await tempDir();
		let calls = 0;
		const logs: string[] = [];
		const res = await refreshCatalogAndRegenerate(["p"], {
			agentDir: dir,
			signalImpl: noSignal,
			fetchImpl: fakeFetch(() =>
				jsonResponse([{ id: "m" }], {
					headers: { "last-modified": "Wed, 01 Oct 2026 00:00:00 GMT" },
				}),
			),
			regenerate: async () => {
				calls++;
			},
			log: (m) => logs.push(m),
		});
		expect(res.changed).toBe(true);
		expect(calls).toBe(1);
		expect(logs.join("\n")).toContain("模型目录已更新：p");
	});

	test("无变化 → 不调 regenerate", async () => {
		const dir = await tempDir();
		const respond = () =>
			fakeFetch(() => jsonResponse([{ id: "m" }], { headers: { "last-modified": "x" } }));
		await refreshCatalogAndRegenerate(["p"], {
			agentDir: dir,
			signalImpl: noSignal,
			fetchImpl: respond(),
			regenerate: async () => {},
			log: () => {},
		});
		let calls = 0;
		await refreshCatalogAndRegenerate(["p"], {
			agentDir: dir,
			signalImpl: noSignal,
			fetchImpl: respond(),
			regenerate: async () => {
				calls++;
			},
			log: () => {},
		});
		expect(calls).toBe(0);
	});

	test("regenerate 抛错不外泄（旧 extension 仍生效）", async () => {
		const dir = await tempDir();
		const logs: string[] = [];
		const res = await refreshCatalogAndRegenerate(["p"], {
			agentDir: dir,
			signalImpl: noSignal,
			fetchImpl: fakeFetch(() => jsonResponse([{ id: "m" }])),
			regenerate: async () => {
				throw new Error("boom");
			},
			log: (m) => logs.push(m),
		});
		expect(res.changed).toBe(true);
		expect(logs.join("\n")).toContain("重建失败");
	});

	test("拉取失败 → 记入 failed 并打日志，但仍不抛错", async () => {
		const dir = await tempDir();
		const logs: string[] = [];
		const res = await refreshCatalogAndRegenerate(["p"], {
			agentDir: dir,
			signalImpl: noSignal,
			fetchImpl: fakeFetch(() => {
				throw new Error("offline");
			}),
			regenerate: async () => {},
			log: (m) => logs.push(m),
		});
		expect(res.changed).toBe(false);
		expect(res.failed).toEqual(["p"]);
		expect(logs.join("\n")).toContain("继续用现有数据");
	});
});
