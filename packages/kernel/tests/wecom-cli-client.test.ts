// wecom-cli-client 语义：
// - getToken：botId+secret 签名（sha256_hex(secret+botId+time+nonce)）→ POST get_cli_config → Bearer token，缓存复用
// - searchContacts：POST /cli/contact/users/search，body 信封 {"payload":"<json字符串>"}，Authorization Bearer
// - 响应解析链：顶层 {errcode,errmsg,results_json} → results_json 字符串 → {result:"<json字符串>"} → {users,...}
// - 错误码 853004（token 失效）→ 清缓存换新 token 重试一次
import { test, expect } from "bun:test";
import { WecomCliClient } from "../src/channels/wecom-cli-client";

/** 记录 fetch 调用并返回按 URL 区分的 mock 响应；提供恢复函数 */
function mockFetch(routes: {
	[key: string]: (url: string, init: any) => any;
}): () => void {
	const orig = globalThis.fetch;
	const calls: { url: string; init: any }[] = [];
	globalThis.fetch = (async (url: any, init: any) => {
		calls.push({ url: String(url), init });
		const u = String(url);
		for (const [key, fn] of Object.entries(routes)) {
			if (u.includes(key)) {
				return {
					ok: true,
					status: 200,
					headers: new Headers(),
					json: async () => fn(u, init),
				} as any;
			}
		}
		throw new Error(`unexpected fetch: ${u}`);
	}) as any;
	return () => {
		globalThis.fetch = orig;
	};
}

const RESP_OK = { errcode: 0, errmsg: "ok" };

test("getToken 用 botId+secret 签名请求 get_cli_config 并返回 token", async () => {
	let called: any = null;
	const restore = mockFetch({
		get_cli_config: (url, init) => {
			called = { url, init };
			return { token: "tok_abc", ...RESP_OK };
		},
	});
	try {
		const client = new WecomCliClient({ botId: "bot_1", secret: "sec_1" });
		const token = await client.getToken();
		expect(token).toBe("tok_abc");
		expect(called.url).toContain(
			"qyapi.weixin.qq.com/cgi-bin/aibot/cli/get_cli_config",
		);
		const body = JSON.parse(called.init.body);
		expect(body.bot_id).toBe("bot_1");
		expect(typeof body.time).toBe("number");
		expect(typeof body.nonce).toBe("string");
		expect(typeof body.signature).toBe("string");
		expect(body.signature).toHaveLength(64); // sha256 hex
	} finally {
		restore();
	}
});

test("getToken 重复调用复用缓存（只请求一次）", async () => {
	let count = 0;
	const restore = mockFetch({
		get_cli_config: () => {
			count++;
			return { token: "tok_abc", ...RESP_OK };
		},
	});
	try {
		const client = new WecomCliClient({ botId: "bot_1", secret: "sec_1" });
		await client.getToken();
		await client.getToken();
		expect(count).toBe(1);
	} finally {
		restore();
	}
});

test("getToken 返回 errcode!=0 → 抛中文错误", async () => {
	const restore = mockFetch({
		get_cli_config: () => ({ errcode: 40001, errmsg: "secret 错误" }),
	});
	try {
		const client = new WecomCliClient({ botId: "bot_1", secret: "bad" });
		await expect(client.getToken()).rejects.toThrow(/secret 错误/);
	} finally {
		restore();
	}
});

test("searchContacts 请求带 payload 信封 + Bearer token，解析三层 JSON 返回 users", async () => {
	let called: any = null;
	const restore = mockFetch({
		get_cli_config: () => ({ token: "tok_abc", ...RESP_OK }),
		"contact/users/search": (url, init) => {
			called = { url, init };
			return {
				...RESP_OK,
				results_json: JSON.stringify({
					result: JSON.stringify({
						users: [
							{
								userid: "woq4...1",
								name: "张文明",
								position: "测试经理",
								departments: ["七圣/测试组"],
								email: "a@b.c",
								matched_keywords: ["张"],
							},
							{ userid: "woq4...2", name: "张惠梅" },
						],
						users_count: 2,
					}),
				}),
			};
		},
	});
	try {
		const client = new WecomCliClient({ botId: "bot_1", secret: "sec_1" });
		const users = await client.searchContacts(["张"]);
		expect(called.url).toContain("/cli/contact/users/search");
		expect(called.init.headers.Authorization).toBe("Bearer tok_abc");
		// payload 信封：body 是 {"payload":"<json字符串>"}
		const outer = JSON.parse(called.init.body);
		const inner = JSON.parse(outer.payload);
		expect(inner.keywords).toEqual(["张"]);
		expect(users).toHaveLength(2);
		expect(users[0]).toMatchObject({ userid: "woq4...1", name: "张文明" });
	} finally {
		restore();
	}
});

test("searchContacts 传 search_mode 透传", async () => {
	let outer: any = null;
	const restore = mockFetch({
		get_cli_config: () => ({ token: "tok", ...RESP_OK }),
		"contact/users/search": (_url, init) => {
			outer = JSON.parse(init.body);
			return {
				...RESP_OK,
				results_json: JSON.stringify({ result: JSON.stringify({ users: [] }) }),
			};
		},
	});
	try {
		const client = new WecomCliClient({ botId: "b", secret: "s" });
		await client.searchContacts(["李"], "list");
		expect(JSON.parse(outer.payload).search_mode).toBe("list");
	} finally {
		restore();
	}
});

test("searchContacts 遇 853004（token 失效）→ 换新 token 重试一次并成功", async () => {
	const urls: string[] = [];
	let tokenIssueCount = 0;
	const restore = mockFetch({
		get_cli_config: () => {
			tokenIssueCount++;
			return { token: `tok_${tokenIssueCount}`, ...RESP_OK };
		},
		"contact/users/search": (_url, init) => {
			urls.push(init.headers.Authorization);
			if (init.headers.Authorization === "Bearer tok_1") {
				return { errcode: 853004, errmsg: "token expired" };
			}
			return {
				...RESP_OK,
				results_json: JSON.stringify({
					result: JSON.stringify({ users: [{ userid: "u1", name: "张三" }] }),
				}),
			};
		},
	});
	try {
		const client = new WecomCliClient({ botId: "b", secret: "s" });
		const users = await client.searchContacts(["张"]);
		expect(users).toHaveLength(1);
		expect(urls).toEqual(["Bearer tok_1", "Bearer tok_2"]);
		expect(tokenIssueCount).toBe(2);
	} finally {
		restore();
	}
});

test("searchContacts 非 853004 业务错误 → 抛 errmsg", async () => {
	const restore = mockFetch({
		get_cli_config: () => ({ token: "tok", ...RESP_OK }),
		"contact/users/search": () => ({
			errcode: 40058,
			errmsg: "'keywords' 不合法",
		}),
	});
	try {
		const client = new WecomCliClient({ botId: "b", secret: "s" });
		await expect(client.searchContacts([])).rejects.toThrow(/keywords/);
	} finally {
		restore();
	}
});
