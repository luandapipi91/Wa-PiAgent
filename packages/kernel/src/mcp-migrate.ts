// 旧配置迁移：pi-mcp-adapter 时代的 <cwd>/.mcp.json → 内置 <cwd>/.pi/mcp.json（规格 §4.2 / §8）。
//
// 三条铁律：
//   1. 旧文件保留 —— adapter 仍在读 <cwd>/.mcp.json，删除会造成中间态回归；
//      仅额外留一份 .mcp.json.bak-<ts> 供回退。
//   2. 失败绝不半写 —— 旧文件不存在/解析失败时不碰新文件（连 .pi 目录都不创建），
//      否则会在用户仓库里凭空造出 .pi/（该项目随即变成「需要受信」的项目）。
//   3. 幂等 —— 重复调用产出同一份新文件内容。
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { McpExposure, McpServerConfig } from "@wa-pi/shared";
import { projectMcpPath } from "./mcp-file.ts";

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

/**
 * 一次性迁移：<cwd>/.mcp.json → <cwd>/.pi/mcp.json。
 * 旧文件保留并额外备份为 .mcp.json.bak-<ts>；任何失败都不写新文件（规格 §8）。
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
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
		return { migrated: 0 };
	}
	const globalDefaultDirect = legacy.settings?.directTools;
	const migrated: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(servers)) {
		if (!entry || typeof entry !== "object") continue;
		const base =
			globalDefaultDirect === undefined
				? entry
				: { directTools: globalDefaultDirect, ...entry };
		migrated[name] = migrateServerEntry(base);
	}
	// 没有可迁移的条目就不写盘：不新建 .pi/，也不重排既有文件
	if (Object.keys(migrated).length === 0) return { migrated: 0 };

	// 目标文件损坏时 JSON.parse 抛错 → 迁移整体放弃（不覆盖用户既有数据），由调用方兜底
	const existing = existsSync(targetPath)
		? JSON.parse(await readFile(targetPath, "utf8"))
		: { mcpServers: {} };
	const merged = {
		...existing,
		mcpServers: { ...(existing.mcpServers ?? {}), ...migrated },
	};
	await mkdir(dirname(targetPath), { recursive: true });
	// 原子替换（同 mcp-file.ts）：先写临时文件再 rename，避免中途失败留下半截 JSON——
	// 那会让下次迁移因目标解析失败而永久中止（旧文件还在，但已无人能自动修复）
	const tmp = `${targetPath}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(merged, null, 2), "utf8");
	await rename(tmp, targetPath);

	const backup = `${legacyPath}.bak-${Date.now()}`;
	await copyFile(legacyPath, backup);
	return { migrated: Object.keys(migrated).length, backup };
}
