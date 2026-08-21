// bridge-extension.ts —— 部署 wa-pi-bridge 扩展到 GENERATED_DIR。
//
// RPC 模式下 pi 以子进程运行，SDK 的 customTools 机制不存在。
// 替代方案：kernel 把静态扩展文件 wa-pi-bridge.extension.ts 连同依赖的
// tool-schemas.ts（来自 @wa-pi/shared）复制到 GENERATED_DIR，
// pi 经 -e 加载并注册 7 个宿主工具（ask_user_question / memory_* / delegate / fleet）。
// 工具 execute 在 pi 进程内经 HTTP 回调 kernel 的 /bridge/tool 端点。
//
// 与旧版差异：不再动态生成 TypeScript 代码（generateBridgeExtension），
// 改为部署静态文件 + 相对 import。工具文案与 Schema 统一来源于
// @wa-pi/shared/tool-schemas.ts，kernel 侧和 bridge 侧引用同一份定义。

import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_DIR } from "@wa-pi/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 生成的 bridge 扩展文件路径（kernel spawn pi 时经 -e 注入） */
export const BRIDGE_EXTENSION_PATH = join(GENERATED_DIR, "wa-pi-bridge.ts");

/** tool-schemas.ts 在 GENERATED_DIR 的路径（bridge 扩展的相对 import 目标） */
const TOOL_SCHEMAS_TARGET = join(GENERATED_DIR, "tool-schemas.ts");

/** file-snapshot.ts 在 GENERATED_DIR 的路径（bridge 扩展的相对 import 目标） */
const FILE_SNAPSHOT_TARGET = join(GENERATED_DIR, "file-snapshot.ts");

/**
 * 静态 bridge 扩展源文件。
 * - packaged：build-kernel-sidecar 将 wa-pi-bridge.extension.ts 复制到 kernel.js 同级 → 优先取。
 * - dev：回退到 monorepo 源码路径。
 */
function resolveBridgeExtensionSource(): string {
 const flat = join(__dirname, "wa-pi-bridge.extension.ts");
 if (existsSync(flat)) return flat;
 // POC: bun --compile --asset 把文件嵌入到 import.meta.dir/assets/ 子目录
 const inAssets = join(__dirname, "assets", "wa-pi-bridge.extension.ts");
 if (existsSync(inAssets)) return inAssets;
 return join(__dirname, "wa-pi-bridge.extension.ts"); // 兜底同路径（bundled kernel 场景）
}

/**
 * tool-schemas 源文件。
 * - packaged：build-kernel-sidecar 将 tool-schemas.ts 复制到 kernel.js 同级 → 优先取。
 * - dev：回退到 monorepo packages/shared/src/tool-schemas.ts。
 */
function resolveToolSchemasSource(): string {
 const flat = join(__dirname, "tool-schemas.ts");
 if (existsSync(flat)) return flat;
 // POC: bun --compile --asset 嵌入到 assets/ 子目录
 const inAssets = join(__dirname, "assets", "tool-schemas.ts");
 if (existsSync(inAssets)) return inAssets;
 return join(__dirname, "..", "..", "shared", "src", "tool-schemas.ts");
}

/**
 * file-snapshot 源文件（与 wa-pi-bridge.extension.ts 同目录，位于 kernel/src）。
 * - packaged：build-kernel-sidecar 将 file-snapshot.ts 复制到 kernel.js 同级 → 优先取。
 * - dev：同路径即可。
 */
function resolveFileSnapshotSource(): string {
 const flat = join(__dirname, "file-snapshot.ts");
 if (existsSync(flat)) return flat;
 const inAssets = join(__dirname, "assets", "file-snapshot.ts");
 if (existsSync(inAssets)) return inAssets;
 return join(__dirname, "file-snapshot.ts");
}

const BRIDGE_EXTENSION_SOURCE = resolveBridgeExtensionSource();
const TOOL_SCHEMAS_SOURCE = resolveToolSchemasSource();
const FILE_SNAPSHOT_SOURCE = resolveFileSnapshotSource();

/**
 * 部署 bridge 扩展到 GENERATED_DIR：复制静态扩展文件 + tool-schemas 依赖。
 * 每次覆盖写，幂等。返回 bridge 扩展入口路径。
 */
export async function ensureBridgeExtension(): Promise<string> {
 await mkdir(GENERATED_DIR, { recursive: true });
 // POC：bun --compile 虚拟 FS 里 copyFile 不可用，改 readFileSync + writeFile。
 // 生产（解释运行/磁盘）语义一致：源文件内容完整复制。
 const { writeFile } = await import("node:fs/promises");
 await writeFile(TOOL_SCHEMAS_TARGET, readFileSync(TOOL_SCHEMAS_SOURCE));
 await writeFile(FILE_SNAPSHOT_TARGET, readFileSync(FILE_SNAPSHOT_SOURCE));
 await writeFile(BRIDGE_EXTENSION_PATH, readFileSync(BRIDGE_EXTENSION_SOURCE));
 return BRIDGE_EXTENSION_PATH;
}

/**
 * 返回 bridge 扩展源码（兼容旧测试引用）。
 * 不再动态生成——改为读取静态源文件内容。
 */
export function generateBridgeExtension(): string {
 return readFileSync(BRIDGE_EXTENSION_SOURCE, "utf8");
}
