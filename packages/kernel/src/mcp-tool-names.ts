// pi 内置 MCP 扩展的工具命名复刻（规格 F4）。
//
// 为什么必须复刻：受限 agent 的 `--tools` 是**精确白名单**。名字与 pi 实际注册出的工具名
// 不一致时，pi 找不到该工具却**不报错**——那个 MCP 工具对该 agent 静默不可用。而 pi 的
// 注册名不是朴素拼接：非法字符会替换成 `_`，超过 64 字符或与其它 MCP 工具撞名时退化为
// `截断前缀_<sha256(server\0tool) 前 8 位>`。
//
// 复刻来源：pi-coding-agent 0.99.1
//   - dist/extensions/mcp/tools.js 的 createMcpToolName（sanitize + 截断/hash 公式）
//   - dist/extensions/mcp/index.js 的 registerTools（toolOwners / current 撞名去重表）
import { createHash } from "node:crypto";
import type { McpExposure } from "@wa-pi/shared";
import type { McpServerReport } from "./mcp-admin";

/** Provider 工具名的长度上限（64 个 `[A-Za-z0-9_-]` 字符，与 pi 同值） */
export const MAX_TOOL_NAME_LENGTH = 64;

/** 简式名：`mcp__<server>__<tool>` 的非法字符替换为 `_`（未计长度/撞名退化） */
function sanitizedMcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** 退化名：`简式名.slice(0, 55)_<sha256(server\0tool) 前 8 位>`（长度恒为 64） */
function hashedMcpToolName(server: string, tool: string, sanitized: string): string {
  const hash = createHash("sha256")
    .update(`${server}\0${tool}`)
    .digest("hex")
    .slice(0, 8);
  return `${sanitized.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/**
 * pi 的 `createMcpToolName`：`mcp__<server>__<tool>`，sanitize 后超过 {@link MAX_TOOL_NAME_LENGTH}
 * 或被 `isTaken` 判定已占用时改用 hash 变体。
 *
 * `isTaken` 对应 pi 注册时的去重表（同一 server 内 sanitize 撞名，或跨 server 同名）——
 * 名字被别的工具占了就退化，否则两个工具会同名。
 */
export function createMcpToolName(
  server: string,
  tool: string,
  isTaken: (name: string) => boolean = () => false,
): string {
  const sanitized = sanitizedMcpToolName(server, tool);
  if (sanitized.length <= MAX_TOOL_NAME_LENGTH && !isTaken(sanitized)) {
    return sanitized;
  }
  return hashedMcpToolName(server, tool, sanitized);
}

/**
 * 非 direct 曝光对应的**入口工具**（规格 §6）：pi 的 `ensureDiscoveryActive`
 * （`dist/extensions/mcp/index.js`）就是按曝光档激活入口——`codemode` / `codemode-deferred`
 * 激活 `codemode`，`deferred` 激活 `tool_search`。白名单里没有入口工具时，这些工具即便被
 * pi 注册了也没人能调到（pi 对未列入 `--tools` 的名字**完全不注册**，见 POC R2a/R2b）。
 *
 * `hidden` 无入口：pi 文档明确「makes them unreachable」。
 */
const EXPOSURE_ENTRY_TOOL: Partial<Record<McpExposure, string>> = {
  codemode: "codemode",
  "codemode-deferred": "codemode",
  deferred: "tool_search",
};

/**
 * 枚举 pi 内置 MCP 扩展会注册出的工具名（受限 agent 白名单 / 工具清单用）。
 *
 * 输出**所有已连服务器**的工具名，不按 exposure 过滤：pi 对一切已连服务器的工具都先
 * `assignName` 注册（exposure 只决定注册后怎么被模型看见），而 `--tools` 白名单决定
 * 「注册哪些名字」——按 exposure 过滤会静默丢能力（pi 忽略未注册的名字且不报错）。
 *
 * 非 direct 工具必须同时有**入口工具**才可达，故当已连服务器里有非 direct 曝光时，连它的
 * 入口工具一起输出（见 {@link EXPOSURE_ENTRY_TOOL}）：`codemode` 覆盖 codemode /
 * codemode-deferred，`tool_search` 覆盖 deferred（规格 §6）。多列一个名字是无害的（pi 忽略
 * 未知工具名，也只在真正需要时激活入口），漏列才是「工具静默不可用」。
 *
 * 连不上/已停用的服务器不进输出：pi 连不上就没注册任何名字，其工具名未知。
 *
 * **撞名的处理（与 pi 略有出入，方向是「宽松」）**：pi 的注册顺序取决于各 server 的连接
 * 完成先后（异步），单次 `pi mcp list --json` 快照无法判定「简式名归谁、谁退化为 hash」。
 * 因此当同一简式名有 ≥2 个候选工具（同 server 内 sanitize 撞名，或跨 server 同名）时，
 * 本函数把**简式名与各自的 hash 变体都**输出：多列一个 pi 不认识的名字是无害的（pi 忽略
 * 未知工具名），漏列才是「工具静默不可用」。未撞名的工具仍只输出简式名。
 */
export function mcpToolNamesOf(reports: McpServerReport[]): string[] {
  // 简式名 → 竞争者（`<server>\0<tool>`），用于判定撞名。
  // 含**全部** report（含不可用/已停用）：pi 的 `toolOwners` 是跨注册累积的，快照里那些
  // 名字同样可能被占，漏算只会让我们少列 hash 变体（漏列 = 工具静默不可用）。
  const contendersOf = new Map<string, string[]>();
  const candidates: Array<{
    server: string;
    tool: string;
    plain: string;
    /** 该 server 已连上（pi 真注册了它的工具）→ 名字进输出 */
    emit: boolean;
  }> = [];
  const entryTools: string[] = [];
  for (const report of reports) {
    const emit = report.state === "connected";
    for (const tool of report.tools) {
      const owner = `${report.name}\0${tool}`;
      const known = candidates.some((c) => `${c.server}\0${c.tool}` === owner);
      if (known) continue;
      const plain = sanitizedMcpToolName(report.name, tool);
      const contenders = contendersOf.get(plain);
      if (contenders) contenders.push(owner);
      else contendersOf.set(plain, [owner]);
      candidates.push({ server: report.name, tool, plain, emit });
    }
    // 非 direct 工具靠入口工具到达：已连的非 direct 服务器一并放行其入口
    const entry = EXPOSURE_ENTRY_TOOL[report.exposure];
    if (emit && entry !== undefined && !entryTools.includes(entry)) {
      entryTools.push(entry);
    }
  }

  const out: string[] = [];
  for (const c of candidates) {
    if (!c.emit) continue;
    const contested = (contendersOf.get(c.plain)?.length ?? 0) > 1;
    if (c.plain.length <= MAX_TOOL_NAME_LENGTH && !contested) {
      if (!out.includes(c.plain)) out.push(c.plain);
      continue;
    }
    // 超长或被占：pi 注册的是 hash 变体（超长必退化；被占则视顺序而定）
    const hashed = createMcpToolName(c.server, c.tool, () => true);
    if (!out.includes(hashed)) out.push(hashed);
    // 撞名归属不确定 → 简式名也一并放行（宽松方向，见 JSDoc）
    if (contested && !out.includes(c.plain)) out.push(c.plain);
  }
  // 入口工具跟在工具名之后：非 direct 工具靠它才可达
  for (const entry of entryTools) {
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}
