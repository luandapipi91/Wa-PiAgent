// compaction-overrides.ts — 按「0.2×上下文窗口」规则自动同步压缩预算（pi 0.86+ modelOverrides）
//
// 规则（2026-09-20 已批准）：reserveTokens = round(0.2 × contextWindow)，触发点 80%，
// 与 kernel auto-compact 的 0.8×window 发送前判定对齐（双轨合一）。
// 键必须与 pi 的 `${model.provider}/${model.id}` 对齐——“provider 标识”是注册进 pi 的
// provider slug（provider-extension 的 slugifyProviders：优先 slug 字段，缺则 name 派生，
// 同名加 -2 后缀），不是 providers.json 里的 uuid。
// 所有权边界：
//  - 只写 providers.json 自建模型的 `<slug>/<modelId>` 键（providers.json 为唯一真源）；
//  - 全局 reserveTokens / keepRecentTokens / 内置目录模型一律不写；
//  - 顺手清掉早期版本误用 uuid 写下的键（pi 按 slug 查找，这类键永远查不到）；
//  - settings.json 不存在或坏 JSON → no-op（不为写配置而创建生产文件）；
//  - 模型从 providers.json 移除后旧键残留（无从区分用户手写，宁留勿删）。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WA_PI_DIR, PROVIDERS_FILE, resolveProviderSlug } from "@wa-pi/shared";
import type { ModelProvider } from "@wa-pi/shared";

const RESERVE_RATIO = 0.2;

interface ProviderFileEntry {
	id?: string;
	slug?: string;
	name?: string;
	models?: Array<{ id?: string; contextWindow?: number }>;
}

/** 由 providers.json 结构算出期望的 modelOverrides（跳过缺 id / 非正数窗口的条目） */
export function desiredOverridesFromProviders(
	providers: ProviderFileEntry[],
): Record<string, { reserveTokens: number }> {
	const out: Record<string, { reserveTokens: number }> = {};
	const usedSlugs: string[] = [];
	for (const p of providers ?? []) {
		if (typeof p?.id !== "string" || !p.id) continue;
		// 与 provider-extension 的 slugifyProviders 同一套规则（含同名冲突加后缀），
		// 否则第二个重名 provider 的覆盖键会与第一个相撞、或与 pi 的查找键错开。
		const slug = resolveProviderSlug(p as unknown as ModelProvider, usedSlugs);
		usedSlugs.push(slug);
		for (const m of p?.models ?? []) {
			if (typeof m?.id !== "string" || !m.id) continue;
			if (typeof m?.contextWindow !== "number" || !(m.contextWindow > 0)) continue;
			out[`${slug}/${m.id}`] = { reserveTokens: Math.round(m.contextWindow * RESERVE_RATIO) };
		}
	}
	return out;
}

/** 早期版本误用 provider uuid 写下的键（pi 按 slug 查找，这些键永远查不到） */
function staleUuidKeys(providers: ProviderFileEntry[]): Set<string> {
	const keys = new Set<string>();
	for (const p of providers ?? []) {
		if (typeof p?.id !== "string" || !p.id) continue;
		for (const m of p?.models ?? []) {
			if (typeof m?.id !== "string" || !m.id) continue;
			keys.add(`${p.id}/${m.id}`);
		}
	}
	return keys;
}

/**
 * 把期望值同步进 settings.json 的 compaction.modelOverrides（只增改本规则管理的键）。
 * 失败（文件缺失/坏 JSON/无变化）均静默返回 changed:false——配置同步不允许影响 kernel 启动。
 */
export async function syncCompactionOverrides(
	settingsFile: string = join(WA_PI_DIR, "settings.json"),
	providersFile: string = PROVIDERS_FILE,
): Promise<{ changed: boolean }> {
	let settings: any;
	try {
		settings = JSON.parse(await readFile(settingsFile, "utf8"));
	} catch {
		return { changed: false };
	}
	if (!settings || typeof settings !== "object") return { changed: false };

	let providers: ProviderFileEntry[];
	try {
		providers = (JSON.parse(await readFile(providersFile, "utf8"))?.providers ??
			[]) as ProviderFileEntry[];
	} catch {
		return { changed: false };
	}

	const desired = desiredOverridesFromProviders(providers);
	const stale = staleUuidKeys(providers);
	const compaction = (settings.compaction ??= {});
	const overrides = (compaction.modelOverrides ??= {});
	let changed = false;
	for (const key of Object.keys(overrides)) {
		if (stale.has(key)) {
			delete overrides[key];
			changed = true;
		}
	}
	for (const [key, val] of Object.entries(desired)) {
		const cur = overrides[key];
		if (!cur || cur?.reserveTokens !== val.reserveTokens) {
			overrides[key] = { ...val };
			changed = true;
		}
	}
	if (!changed) return { changed: false };
	await writeFile(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
	return { changed: true };
}
