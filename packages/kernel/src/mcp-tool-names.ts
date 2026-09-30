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
 * 枚举 pi 内置 MCP 扩展会注册出的工具名（受限 agent 白名单 / 工具清单用）。
 *
 * 只输出 `state === "connected" && exposure === "direct"` 的服务器工具：连不上/需登录的
 * 服务器工具名未知，非 direct 曝光（codemode / codemode-deferred / deferred / hidden）
 * 不进白名单、需经 codemode / tool_search 到达（规格 §6）。
 *
 * **撞名的处理（与 pi 略有出入，方向是「宽松」）**：pi 的注册顺序取决于各 server 的连接
 * 完成先后（异步），单次 `pi mcp list --json` 快照无法判定「简式名归谁、谁退化为 hash」。
 * 因此当同一简式名有 ≥2 个候选工具（同 server 内 sanitize 撞名，或跨 server 同名）时，
 * 本函数把**简式名与各自的 hash 变体都**输出：多列一个 pi 不认识的名字是无害的（pi 忽略
 * 未知工具名），漏列才是「工具静默不可用」。未撞名的工具仍只输出简式名。
 */
export function mcpToolNamesOf(reports: McpServerReport[]): string[] {
  // 简式名 → 竞争者（`<server>\0<tool>`），用于判定撞名
  const contendersOf = new Map<string, string[]>();
  const candidates: Array<{
    server: string;
    tool: string;
    plain: string;
    eligible: boolean;
  }> = [];
  for (const report of reports) {
    const eligible = report.state === "connected" && report.exposure === "direct";
    for (const tool of report.tools) {
      const owner = `${report.name}\0${tool}`;
      const known = candidates.some((c) => `${c.server}\0${c.tool}` === owner);
      if (known) continue;
      const plain = sanitizedMcpToolName(report.name, tool);
      const contenders = contendersOf.get(plain);
      if (contenders) contenders.push(owner);
      else contendersOf.set(plain, [owner]);
      candidates.push({ server: report.name, tool, plain, eligible });
    }
  }

  const out: string[] = [];
  for (const c of candidates) {
    if (!c.eligible) continue;
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
  return out;
}
