import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PROVIDERS_FILE, resolveProviderSlug } from "@wa-pi/shared";
import type { ModelProvider } from "@wa-pi/shared";

interface ProvidersFile {
	providers: ModelProvider[];
}

/** pi auth.json 条目（pi 鉴权协议：{ "<providerId>": { type: "api_key", key } } 或 oauth 凭证） */
type AuthFile = Record<
	string,
	{ type: string; key?: string } & Record<string, unknown>
>;

/**
 * 供应商持久化：读写 ~/.pi/agent/providers.json（结构 { providers: [...] }）。
 * 沿用 ConfigStore 的 JSON 文件读写模式：文件不存在视为空。
 *
 * 保存/删除时同步 pi auth.json：pi 鉴权协议规定凭证存储（auth.json）优先于
 * registerProvider 注入的 apiKey（pi-ai resolveProviderAuth），auth.json 残留
 * 过期 key 会静默劫持鉴权（2026-08-09 线上问题：设置页改 key 不生效）。
 * 遵守 pi 协议 = 把用户显式保存的 key 写进凭证存储，而不是对抗它的优先级。
 */
export class ProviderStore {
	private authFile: string;

	constructor(
		private file: string = PROVIDERS_FILE,
		authFile?: string,
	) {
		// auth.json 默认与 providers.json 同目录（生产即 WA_PI_DIR，测试落在各自临时目录）
		this.authFile = authFile ?? join(dirname(file), "auth.json");
	}

	/** 读取全部供应商；文件不存在返回空数组 */
	async load(): Promise<ModelProvider[]> {
		try {
			const raw = await readFile(this.file, "utf8");
			const data = JSON.parse(raw) as ProvidersFile;
			return data.providers ?? [];
		} catch {
			return [];
		}
	}

	/** 新增或更新（按 provider.id upsert，自动规范化 baseUrl 尾部斜杠），并同步 auth.json */
	async save(provider: ModelProvider): Promise<void> {
		// 规范化 baseUrl：去掉尾部斜杠，避免双斜杠导致请求失败
		const normalized = {
			...provider,
			baseUrl: provider.baseUrl.replace(/\/+$/, ""),
		};
		const before = await this.load();
		const prev = before.find((p) => p.id === normalized.id);
		const list = [...before];
		const idx = list.findIndex((p) => p.id === normalized.id);
		if (idx >= 0) list[idx] = normalized;
		else list.push(normalized);
		await this.persist(list);

		const newSlug = this.slugFor(list, normalized.id);
		await this.upsertAuth(newSlug, normalized.apiKey);
		// slug 变更（改名/改预设）时清除旧 slug 下 wa-pi 写入的凭证，避免残留
		if (prev) {
			const oldSlug = this.slugFor(before, prev.id);
			if (oldSlug && oldSlug !== newSlug)
				await this.removeAuth(oldSlug, prev.apiKey);
		}
	}

	/** 按 id 删除；不存在则无操作。同步移除 auth.json 中 wa-pi 写入的凭证 */
	async delete(id: string): Promise<void> {
		const list = await this.load();
		const target = list.find((p) => p.id === id);
		await this.persist(list.filter((p) => p.id !== id));
		if (target) await this.removeAuth(this.slugFor(list, id), target.apiKey);
	}

	/** 写盘 */
	private async persist(providers: ModelProvider[]): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true });
		const data: ProvidersFile = { providers };
		await writeFile(this.file, JSON.stringify(data, null, 2), "utf8");
	}

	/** 按 slugifyProviders 同序推导某 provider 的注册 slug（与 provider-extension.ts 一致） */
	private slugFor(list: ModelProvider[], id: string): string | undefined {
		const used: string[] = [];
		for (const p of list) {
			const slug = resolveProviderSlug(p, used);
			used.push(slug);
			if (p.id === id) return slug;
		}
		return undefined;
	}

	private async readAuth(): Promise<AuthFile> {
		try {
			return JSON.parse(await readFile(this.authFile, "utf8")) as AuthFile;
		} catch (e) {
			// 文件不存在视为空；JSON 损坏则抛错（pi 同样会报错，不静默掩盖）
			if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return {};
			throw e;
		}
	}

	private async writeAuth(data: AuthFile): Promise<void> {
		await mkdir(dirname(this.authFile), { recursive: true });
		await writeFile(this.authFile, JSON.stringify(data, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
	}

	/**
	 * 写入/覆盖 wa-pi 管理的 api_key 凭证（用户显式保存的 key 应生效）。
	 * 不覆盖 oauth 条目：那是 pi CLI /login 的用户凭证（含刷新令牌），与 wa-pi 无关。
	 */
	private async upsertAuth(
		slug: string | undefined,
		apiKey: string,
	): Promise<void> {
		if (!slug) return;
		const data = await this.readAuth();
		if (data[slug]?.type === "oauth") return;
		data[slug] = { type: "api_key", key: apiKey };
		await this.writeAuth(data);
	}

	/** 仅当条目确为 wa-pi 写入（type=api_key 且 key 匹配）时移除，不动用户自行 login 的凭证 */
	private async removeAuth(
		slug: string | undefined,
		apiKey: string,
	): Promise<void> {
		if (!slug) return;
		const data = await this.readAuth();
		if (data[slug]?.type === "api_key" && data[slug].key === apiKey) {
			delete data[slug];
			await this.writeAuth(data);
		}
	}
}
