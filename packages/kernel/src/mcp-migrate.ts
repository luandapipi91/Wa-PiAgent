// 旧配置迁移：pi-mcp-adapter 时代的配置 → 内置 schema（规格 §4.2 / §8）。
//
// 两个作用域，两种写法（关键差异：全局 mcp.json 是 adapter 与 pi **共读的共享文件**）：
//   - 项目级 <cwd>/.mcp.json 是 adapter 独占 → 破坏性映射成 <cwd>/.pi/mcp.json，丢弃 adapter 独有字段。
//   - 全局 <WA_PI_DIR>/mcp.json 是共享文件 → **加法映射**：旧字段原样保留（任务 6 移除 adapter 前
//     它仍需可读），只补写 exposure / toolExposure / timeout，settings 段与未知顶层字段一律不动。
//
// 三条铁律：
//   1. 旧文件保留 —— adapter 仍在读 <cwd>/.mcp.json，删除会造成中间态回归；
//      仅额外留一份备份供回退（固定名 .mcp.json.bak / 全局 mcp.json.bak，已存在则不覆盖）。
//   2. 失败绝不半写 —— 旧文件不存在/解析失败时不碰新文件（连 .pi 目录都不创建），
//      否则会在用户仓库里凭空造出 .pi/（该项目随即变成「需要受信」的项目）。
//   3. 一过性（幂等）—— 迁移只在首次真正生效：目标里已存在的条目跳过、内置字段只补缺失，
//      无变化时不落盘、不覆写用户在目标文件上的编辑、不产生第二个备份。
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { McpExposure, McpServerConfig } from "@wa-pi/shared";
import { projectMcpPath } from "./mcp-file.ts";

type RawObj = Record<string, unknown>;

function isRawObj(value: unknown): value is RawObj {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** adapter 独有、内置实现不认的字段：迁移时直接丢弃（规格 §4.2） */
const DROPPED_KEYS = [
	"lifecycle",
	"idleTimeout",
	"debug",
	"exposeResources",
	"toolPrefix",
	"settings",
] as const;

/** 把一条 adapter 时代的服务器条目映射成内置 schema（规格 §4.2） */
export function migrateServerEntry(
	raw: Record<string, unknown>,
): McpServerConfig & Record<string, unknown> {
	const out: Record<string, unknown> = { ...raw };
	for (const key of DROPPED_KEYS) delete out[key];

	if (typeof raw.requestTimeoutMs === "number" && raw.requestTimeoutMs > 0) {
		out.timeout = Math.max(1, Math.ceil(raw.requestTimeoutMs / 1000));
		delete out.requestTimeoutMs;
	}

	const toolExposure: Record<string, McpExposure> = {
		...(raw.toolExposure as Record<string, McpExposure> | undefined),
	};

	const direct = raw.directTools;
	if (direct === true) {
		out.exposure = "direct";
	} else if (direct === false) {
		out.exposure = "codemode";
	} else if (Array.isArray(direct)) {
		out.exposure = "codemode";
		for (const name of direct) if (typeof name === "string") toolExposure[name] = "direct";
	} else if (out.exposure === undefined) {
		// 规格 §4.2：新加服务器默认 direct，保持 Wa-Pi 现有交互
		out.exposure = "direct";
	}
	delete out.directTools;

	if (Array.isArray(raw.excludeTools)) {
		for (const name of raw.excludeTools) {
			if (typeof name === "string") toolExposure[name] = "hidden";
		}
	}
	delete out.excludeTools;

	if (Object.keys(toolExposure).length > 0) out.toolExposure = toolExposure;

	return out as McpServerConfig & Record<string, unknown>;
}

/** 全局条目里能映射出内置字段的旧字段；只有它们才触发补写与落盘 */
const LEGACY_ENTRY_KEYS = ["directTools", "requestTimeoutMs", "excludeTools"] as const;

/** 全局加法映射要补写的新字段（旧字段全部保留，供任务 6 之前的 adapter 继续读） */
const ADDED_KEYS = ["timeout", "exposure", "toolExposure"] as const;

/**
 * `directTools` 里的 `server/tool` 限定名防御：`/` 前的前缀只有在等于**当前正在迁移的
 * 服务器名**时才有效，取 `/` 之后的部分作为工具名；前缀不符说明该条属于别的服务器，丢弃。
 * （adapter 源码已不可得，按此保守规则处理，不做进一步考证。）
 */
function resolveQualifiedNames(value: unknown, serverName: string): unknown {
	if (!Array.isArray(value)) return value;
	const names: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const slash = item.indexOf("/");
		if (slash === -1) {
			names.push(item);
			continue;
		}
		if (item.slice(0, slash) === serverName) {
			const tool = item.slice(slash + 1);
			if (tool) names.push(tool);
		}
	}
	return names;
}

/**
 * 全局单条服务器的**加法映射**：复用 migrateServerEntry 的映射结果，但只把新字段
 * （timeout / exposure / toolExposure）**补到缺失处**，旧字段一个不删。
 * 没有任何旧字段时原样返回——不凭空补默认值，避免每次启动重写文件、刷备份。
 */
function migrateGlobalServerEntry(
	name: string,
	entry: RawObj,
	globalDirectTools: unknown,
): RawObj {
	const hasLegacy =
		globalDirectTools !== undefined ||
		LEGACY_ENTRY_KEYS.some((key) => entry[key] !== undefined);
	if (!hasLegacy) return entry;

	const effective = entry.directTools !== undefined ? entry.directTools : globalDirectTools;
	const base: RawObj = { ...entry, directTools: resolveQualifiedNames(effective, name) };
	const mapped = migrateServerEntry(base) as RawObj;

	const out: RawObj = { ...entry };
	for (const key of ADDED_KEYS) {
		// 只补缺失：内置字段一旦已存在（用户在新 schema 上编辑过）就不再按旧字段重算，
		// 否则旧字段被刻意保留 ⇒ 每次启动都会把 exposure 静默回退、并因出现差异再刷一次备份
		if (out[key] !== undefined) continue;
		const value = mapped[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/**
 * 一次性迁移：<WA_PI_DIR>/mcp.json 的 adapter 字段 → 内置字段（**加法映射**，规格 §4.2）。
 * 全局文件是 pi-mcp-adapter 与 pi 共读的共享文件，任务 6 移除 adapter 之前必须保持旧字段可读，
 * 故只补写、不破坏性改写：`settings` 段与未知顶层字段原样保留，另留一份 mcp.json.bak
 * （固定名，已存在则不覆盖，故不随启动次数累积）。
 * 没有任何旧字段可映射、或内置字段都已存在时不落盘（不凭空产生备份文件）。
 */
export async function migrateGlobalMcpFile(
	waPiDir: string,
): Promise<{ migrated: number; backup?: string }> {
	const globalPath = join(waPiDir, "mcp.json");
	if (!existsSync(globalPath)) return { migrated: 0 };

	let originalText: string;
	let parsed: unknown;
	try {
		originalText = await readFile(globalPath, "utf8");
		parsed = JSON.parse(originalText);
	} catch {
		// 文件损坏：保持原样（宁可漏迁移，不可半写）
		return { migrated: 0 };
	}
	if (!isRawObj(parsed)) return { migrated: 0 };
	const servers = parsed.mcpServers;
	if (!isRawObj(servers)) return { migrated: 0 };

	const settings = isRawObj(parsed.settings) ? parsed.settings : undefined;
	const next: Record<string, unknown> = {};
	let migrated = 0;
	for (const [name, entry] of Object.entries(servers)) {
		if (!isRawObj(entry)) {
			next[name] = entry;
			continue;
		}
		const mapped = migrateGlobalServerEntry(name, entry, settings?.directTools);
		if (JSON.stringify(mapped) !== JSON.stringify(entry)) migrated++;
		next[name] = mapped;
	}
	// 没有可补写的条目：不写盘、不产生备份（幂等重跑的常态）
	if (migrated === 0) return { migrated: 0 };

	// settings 段与其他未知顶层字段原样保留（加法映射：任务 6 前 adapter 仍读 settings.*）
	const merged = { ...parsed, mcpServers: next };
	await mkdir(dirname(globalPath), { recursive: true });
	const tmp = `${globalPath}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(merged, null, 2), "utf8");
	await rename(tmp, globalPath);

	// 备份迁移前的原文（此刻盘上已是新内容，故用先读到的文本写备份）；固定名，不累积
	const backup = `${globalPath}.bak`;
	if (!existsSync(backup)) await writeFile(backup, originalText, "utf8");
	return { migrated, backup };
}

/**
 * 一次性迁移：<cwd>/.mcp.json → <cwd>/.pi/mcp.json。
 *
 * 一过性（幂等）语义：
 *   - 目标里**已存在的同名条目一律跳过** —— 绝不用旧配置覆掉用户在新 schema 上的编辑；
 *   - 没有任何条目需要迁移（含全部跳过）→ 直接返回，不落盘、不产生备份；
 *   - 将要写入的内容与盘上文本相同 → 同样视作 no-op，不落盘、不产生备份。
 * 旧文件保留，另行备份为固定名 .mcp.json.bak（已存在则不覆盖），故备份数量恒为 1。
 * 任何失败都不写新文件（规格 §8）。
 */
export async function migrateProjectMcpFile(
	projectCwd: string,
): Promise<{ migrated: number; backup?: string }> {
	const legacyPath = join(projectCwd, ".mcp.json");
	const targetPath = projectMcpPath(projectCwd);
	// 没有旧文件 = 无事可做。必须在这里就返回：下方的 mkdir 会凭空造出 .pi/
	// 目录，让本来「干净」的项目变成需要受信的项目。
	if (!existsSync(legacyPath)) return { migrated: 0 };

	let legacy: {
		mcpServers?: Record<string, Record<string, unknown>>;
		settings?: Record<string, unknown>;
	};
	try {
		legacy = JSON.parse(await readFile(legacyPath, "utf8"));
	} catch {
		// 旧文件损坏：保持原样、不动新文件（宁可漏迁移，不可半写）
		return { migrated: 0 };
	}
	if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
		return { migrated: 0 };
	}

	const servers = legacy.mcpServers;
	if (!isRawObj(servers)) return { migrated: 0 };

	// 目标文件损坏时 JSON.parse 抛错 → 迁移整体放弃（不覆盖用户既有数据），由调用方兜底
	const targetExists = existsSync(targetPath);
	const existingText = targetExists ? await readFile(targetPath, "utf8") : "";
	const existing: RawObj = targetExists ? JSON.parse(existingText) : { mcpServers: {} };
	const existingServers = (existing.mcpServers ?? {}) as RawObj;

	const globalDefaultDirect = legacy.settings?.directTools;
	const migratedServers: RawObj = {};
	for (const [name, entry] of Object.entries(servers)) {
		if (!isRawObj(entry)) continue;
		// 一过性：目标里已有同名条目 → 跳过，保留用户在 .pi/mcp.json 上的编辑
		if (existingServers[name] !== undefined) continue;
		// settings.directTools 作缺省、条目自身优先；`server/tool` 限定名与全局路径同规则
		const effective =
			entry.directTools !== undefined ? entry.directTools : globalDefaultDirect;
		migratedServers[name] = migrateServerEntry({
			...entry,
			directTools: resolveQualifiedNames(effective, name),
		});
	}
	const migratedCount = Object.keys(migratedServers).length;
	// 没有可迁移的条目就不写盘：不新建 .pi/，也不重排既有文件，更不产生备份
	if (migratedCount === 0) return { migrated: 0 };

	const merged = {
		...existing,
		mcpServers: { ...existingServers, ...migratedServers },
	};
	const nextText = JSON.stringify(merged, null, 2);
	// 内容无变化同样是 no-op：不落盘、不产生备份（旧文件被刻意保留 ⇒ 每次启动都会重算）
	if (targetExists && nextText === existingText) return { migrated: 0 };

	await mkdir(dirname(targetPath), { recursive: true });
	// 原子替换（同 mcp-file.ts）：先写临时文件再 rename，避免中途失败留下半截 JSON——
	// 那会让下次迁移因目标解析失败而永久中止（旧文件还在，但已无人能自动修复）
	const tmp = `${targetPath}.${process.pid}.tmp`;
	await writeFile(tmp, nextText, "utf8");
	await rename(tmp, targetPath);

	// 备份旧文件原文：固定名 + 已存在则不覆盖 ⇒ 不会在用户仓库里按启动次数累积 .mcp.json.bak-*
	const backup = `${legacyPath}.bak`;
	if (!existsSync(backup)) await copyFile(legacyPath, backup);
	return { migrated: migratedCount, backup };
}
