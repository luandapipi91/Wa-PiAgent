/**
 * 企业微信 CLI 网关客户端（通讯录搜索）。
 *
 * 鉴权：用机器人已有的 Bot ID + Secret 签名换取 Bearer token（无需 apikey），
 * 签名算法 sha256_hex(secret + bot_id + time + nonce)，请求 get_cli_config；
 * token 失效（错误码 853004）时静默换新重试一次，用户无感。
 * 参考企微官方 CLI（WecomTeam/wecom-cli）同款协议。
 */
import { createHash, randomUUID } from "node:crypto";

export interface WecomCliClientOptions {
	botId: string;
	secret: string;
	/** 测试注入用；默认 globalThis.fetch */
	fetchImpl?: typeof fetch;
}

export interface WecomContactUser {
	userid: string;
	name: string;
	alias?: string;
	position?: string;
	departments?: string[];
	email?: string;
	matched_keywords?: string[];
}

/** token 失效错误码（官方 CLI 用 853004 触发静默刷新） */
const TOKEN_STALE_ERRCODE = 853004;

const AUTH_ENDPOINT =
	"https://qyapi.weixin.qq.com/cgi-bin/aibot/cli/get_cli_config";
const BASE_URL = "https://qyapi.weixin.qq.com/cli";

/** sha256_hex(secret + bot_id + time + nonce) */
export function signCliRequest(
	secret: string,
	botId: string,
	time: number,
	nonce: string,
): string {
	return createHash("sha256")
		.update(`${secret}${botId}${time}${nonce}`)
		.digest("hex");
}

export class WecomCliClient {
	private token?: string;
	private botId: string;
	private secret: string;
	private fetchImpl: typeof fetch;

	constructor(opts: WecomCliClientOptions) {
		this.botId = opts.botId;
		this.secret = opts.secret;
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
	}

	/** 换取并缓存 Bearer token（幂等：已缓存直接返回） */
	async getToken(): Promise<string> {
		if (this.token) return this.token;
		const time = Math.floor(Date.now() / 1000);
		const nonce = `cli_${Date.now()}_${randomUUID().slice(0, 8)}`;
		const signature = signCliRequest(this.secret, this.botId, time, nonce);
		const res = await this.fetchImpl(AUTH_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				bot_id: this.botId,
				time,
				nonce,
				signature,
				bind_source: 1,
			}),
		});
		const data = (await res.json()) as {
			token?: string;
			errcode?: number;
			errmsg?: string;
		};
		if (!data.token || (data.errcode && data.errcode !== 0)) {
			throw new Error(data.errmsg || "获取企微访问令牌失败");
		}
		this.token = data.token;
		return this.token;
	}

	/** 清缓存（token 失效时调用，下次 getToken 重新换取） */
	private invalidateToken(): void {
		this.token = undefined;
	}

	/**
	 * 按关键词搜索企微通讯录成员。
	 * 响应解析链：顶层 {errcode,errmsg,results_json} → results_json 字符串
	 * → {result:"<json字符串>"} → {users:[...]}。853004 时刷新 token 重试一次。
	 */
	async searchContacts(
		keywords: string[],
		searchMode?: string,
	): Promise<WecomContactUser[]> {
		const payload = JSON.stringify(
			searchMode ? { keywords, search_mode: searchMode } : { keywords },
		);
		const body = JSON.stringify({ payload });
		const res = await this.fetchImpl(`${BASE_URL}/contact/users/search`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${await this.getToken()}`,
			},
			body,
		});
		const data = (await res.json()) as {
			errcode?: number;
			errmsg?: string;
			results_json?: string;
		};
		if (data.errcode === TOKEN_STALE_ERRCODE) {
			this.invalidateToken();
			return this.searchContacts(keywords, searchMode); // 换新 token 重试一次
		}
		if (data.errcode && data.errcode !== 0) {
			throw new Error(data.errmsg || "企微通讯录搜索失败");
		}
		if (!data.results_json) return [];
		try {
			const outer = JSON.parse(data.results_json) as { result?: string };
			const inner = outer.result ? JSON.parse(outer.result) : {};
			return (inner.users ?? []) as WecomContactUser[];
		} catch {
			throw new Error("企微通讯录响应解析失败");
		}
	}
}
