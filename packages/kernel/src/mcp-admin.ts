// McpAdmin：MCP 运行状态的**唯一读取者**（规格 §3、§7）。
//
// 本模块自己**不连** MCP —— 只 shell out `pi mcp list --json` 并解析那条 JSON（F14）。
// 盘上配置的写入归 mcp-file.ts、受信归 mcp-trust.ts：这里是只读面。
import type { McpExposure } from "@wa-pi/shared";

/**
 * server URL → pi 存在 mcp-auth.json 里的**旧**键（legacy 键）。
 *
 * pi 用 `String(new URL(url))` 规范化后当键：主机名小写、默认端口省略、无路径 URL 补尾斜杠。
 * 拿配置里原样的字符串去查就会漏判（`https://Host:443` 与盘上的 `https://host/` 不是一个键），
 * 而登录 UI 的「已登录 / 未登录」完全靠这个判断。
 *
 * 非 URL（含 `undefined`/空串/任意非 URL 文本）→ null：调用方一律按「未登录」处理。
 *
 * pi 1.0.0 起的键多了命名空间前缀（见 {@link mcpAuthKey}），但这个规范化仍要保留：
 * pi 的迁移是**惰性**的（只在真正加载某台 server 时才把旧键搬成新键），
 * 盘上随时可能还有只有旧键的 server。
 */
export function normalizeMcpAuthKey(url: string): string | null {
  try {
    return String(new URL(url));
  } catch {
    return null;
  }
}

/**
 * pi 的 MCP 命名空间：`mcp__<server 名，`-` 换成 `_`>`。
 *
 * 复刻自 pi-coding-agent 1.0.0 `dist/core/mcp-servers.js` 的 `mcpNamespace`（0.99.2 同式）。
 * 只换 `-`：server 名本身已被 pi 的 `^[A-Za-z0-9_-]+$` 限死，没有其它非法字符需要处理。
 */
export function mcpNamespace(server: string): string {
  return `mcp__${server.replace(/-/g, "_")}`;
}

/**
 * pi 1.0.0 起的 mcp-auth.json 键：`<命名空间>|<规范化 URL>`
 * （`dist/extensions/mcp/oauth.js` 的 `storeKeys`）。
 *
 * 键里带上 server 名是为了让「同一个 URL 的两台 server」能各存各的凭据。
 * URL 不是合法 URL → null。
 */
export function mcpAuthKey(serverName: string, serverUrl: string): string | null {
  const canonical = normalizeMcpAuthKey(serverUrl);
  return canonical === null ? null : `${mcpNamespace(serverName)}|${canonical}`;
}

/**
 * 某台 server 在凭据键集合里是否有登录凭据（F19）。
 *
 * 认两种键：1.0.0 起的 {@link mcpAuthKey}，以及迁移前的纯规范化 URL。两种都要认——
 * pi 只在加载某台 server 时才把旧键搬成新键，只认新键会把「已登录但尚未被加载过」误判成未登录，
 * 只认旧键则会在迁移后全部判错。
 *
 * 返回 `null` 表示 serverUrl 不是合法 URL、无从判断：调用方应保留「未知」而不是当作未登录
 * （前端对 `undefined` 与 `false` 的渲染不同，前者两个按钮都不画）。
 */
export function mcpAuthKeysOf(
  keys: ReadonlySet<string>,
  serverName: string,
  serverUrl: string,
): boolean | null {
  const canonical = normalizeMcpAuthKey(serverUrl);
  if (canonical === null) return null;
  return keys.has(`${mcpNamespace(serverName)}|${canonical}`) || keys.has(canonical);
}

/**
 * 该 server 是否可能走 OAuth（决定要不要给它下发登录态、前端要不要画登录按钮）。
 *
 * 判据与 pi 逐条对齐（pi 的 `dist/extensions/mcp/runtime.js`：
 * “HTTP servers authenticate with OAuth unless the config supplies an `Authorization`
 * header or `auth`”）：
 *   - 没有 url（stdio）→ 不可能；
 *   - headers 里有 `authorization`（**大小写不敏感**，HTTP 头名本就如此）→ 固定凭据，不是 OAuth；
 *   - 带 `auth` 配置 → 走 `/login` provider 的 token，也不是 OAuth。
 *
 * 不满足时**不下发** `signedIn`（而不是下发 false）：前端把 `undefined` 当“未知”而两边按钮
 * 都不画；给它 false 会画出一个必然失败的「登录」入口——pi 的 login 会直接拒绝：
 * “does not use OAuth. Only HTTP servers without an Authorization header do.”
 */
export function canUseOAuth(config: {
  url?: string;
  headers?: Record<string, string>;
  auth?: unknown;
}): boolean {
  if (!config.url) return false;
  if (config.auth !== undefined) return false;
  return !Object.keys(config.headers ?? {}).some(
    (header) => header.toLowerCase() === "authorization",
  );
}

/**
 * 读 `<agentDir>/mcp-auth.json` 的键集合（规范化后）。
 *
 * 一次性读整份文件供多处比对（列表里每台 HTTP server 都要问一次登录态，逐台重读文件没必要）。
 * 文件缺失 / 非 JSON / 不是「键 → 凭据」的 map → 空集合（不抛错，F19）；
 * 用 `Object.keys` 而不是 `in`，避免把原型链上的键（`toString` 等）当成凭据。
 *
 * 收集两种键形（见 {@link mcpAuthKeysOf}）：1.0.0 起的 `<命名空间>|<URL>` 原样收，
 * 迁移前的纯 URL 键收其规范化形态。两者无法识别的（如 `toString`）丢弃。
 */
export async function readMcpAuthKeys(agentDir: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let raw: unknown;
  try {
    raw = await Bun.file(`${agentDir}/mcp-auth.json`).json();
  } catch {
    return keys; // 文件不存在 / 损坏
  }
  // 数组也是 object：它不可能是键值表，按「形状非法」处理
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return keys;
  for (const k of Object.keys(raw)) {
    // 新键 `<命名空间>|<URL>`：`|` 只会出现在分隔处（URL 里的 `|` 会被 URL 编码）
    const sep = k.indexOf("|");
    if (sep > 0 && normalizeMcpAuthKey(k.slice(sep + 1))) {
      keys.add(k);
      continue;
    }
    const normalized = normalizeMcpAuthKey(k);
    if (normalized) keys.add(normalized);
  }
  return keys;
}

/**
 * 单台服务器的运行时报告（`pi mcp list --json` 的 servers[] 条目）。
 *
 * 命名跟 pi 内部一致（`report`）：**不要**与 `@wa-pi/shared` 的 `McpServerStatus`
 * （WS 事件里的运行时字符串联合 `"disconnected"|"connected"|"error"`）混为一谈，
 * 两者同名不同物。
 */
export interface McpServerReport {
  name: string;
  scope: string;
  source?: string;
  enabled: boolean;
  exposure: McpExposure;
  transport?: string;
  /** pi 已知取值：connected / failed / needs-auth / disabled（另有其它字符串） */
  state: "connected" | "failed" | string;
  tools: string[];
  error?: string;
}

export interface McpListResult {
  /** 条目；`commandFailed:true` 时恒为空 */
  servers: McpServerReport[];
  errors: string[];
  /** 命令本身没跑起来/输出不可解析 */
  commandFailed: boolean;
  /** 有**启用中**的 server 处于异常态（F14：pi 的退出码 1 就映射到这里） */
  hasProblems: boolean;
  /** 项目未被信任时 pi 的提示（F12/F13）——项目配置被静默忽略的唯一信号 */
  note?: string;
  raw?: string;
}

/**
 * 解析 `pi mcp list --json` 的 stdout（纯函数，便于单测）。
 *
 * 退出码语义（F14，POC 实测）：**任一 server 异常时 pi 退 1，但 stdout 仍是合法 JSON**。
 * 所以「命令是否失败」只看这段输出能不能解析成 JSON，退出码 1 只意味着有 server 异常
 * （hasProblems）。反过来，进程压根没起来（输出为空/半截）才是 commandFailed。
 */
export function parseMcpListOutput(
  stdout: string,
  meta: { exitCode: number },
): McpListResult {
  // BOM（Windows 下偶发）与非 JSON 前缀（警告行）都剥掉再解析；整个解析不许抛错（规格 §8）
  const text = stdout.replace(/^\uFEFF/, "").trim();
  const jsonStart = text.indexOf("{");
  try {
    const parsed = JSON.parse(jsonStart >= 0 ? text.slice(jsonStart) : text) as {
      servers?: McpServerReport[];
      errors?: string[];
      note?: string;
    };
    const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
    return {
      servers,
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      commandFailed: false,
      // 只在**启用中**的 server 上判异常：pi 对 enabled:false 的 server 照常输出一条
      // `state:"disabled"` 并退 0，用户刚关掉一台 server 不该被报成异常（F14 的退出码映射）。
      hasProblems:
        servers.some((s) => s.enabled !== false && s.state !== "connected") ||
        (parsed.errors?.length ?? 0) > 0,
      note: parsed.note,
      raw: text,
    };
  } catch {
    return {
      servers: [],
      errors: [],
      commandFailed: true,
      hasProblems: true,
      raw: text,
    };
  }
}

/** `pi mcp list` 的缺省等待上限（毫秒）：一个卡住的 server 不该把 GUI 的 MCP 页永久挂住。
 *
 * 必须大于 pi 引擎对单台 server 的默认超时（60s）：pi 会等每台 server 各自超时后才退出
 * 并报出各台真实状态（实测一台不合规 server 时整体 61s 才完成）。上限若 ≤ 60s，pi 还没
 * 报出状态就被 kill → commandFailed → GUI 整页「状态未知」。
 */
export const DEFAULT_LIST_TIMEOUT_MS = 70_000;

export interface McpAdminOpts {
  /** pi 可执行体与 CLI 路径（与 rpc-client 同一解析） */
  runtime: string;
  cliPath: string;
  agentDir: string;
  cwd: string;
  /**
   * `pi mcp list` 的等待上限，缺省 {@link DEFAULT_LIST_TIMEOUT_MS}。
   * list 会真的去连每台 server，没有上限时一个卡住的 server 就能把调用方
   * （GUI 的 MCP 页）永远挂住。
   */
  timeoutMs?: number;
}

export class McpAdmin {
  private cache?: McpListResult;

  constructor(private opts: McpAdminOpts) {}

  /**
   * 读一次状态。
   *
   * `stale` 只在 `commandFailed:false` 时有意义：`true` 表示「这份 servers 不是本次跑出来的」，
   * 即命令失败（超时/输出不可解析）后回退的旧缓存。不变式：`commandFailed:true` 时 `servers` 恒为空，
   * 此时 `stale:true` 只说明这份失败连一次重跑都没有（直接命中了失败缓存）。
   *
   * 失败结果同样进缓存（`pi mcp list` 会挨个连 server，很贵，失败不该被每次轮询重试），
   * 但缓存命中且缓存本身是失败时必须回 `stale:true`，否则调用方分不清「刚真跑过并失败」与「这是旧失败」。
   */
  async list(force = false): Promise<McpListResult & { stale: boolean }> {
    // 命中失败缓存 → 本次根本没跑，标 stale，别谎报新鲜
    if (!force && this.cache) {
      return { ...this.cache, stale: this.cache.commandFailed };
    }
    const result = await this.runList();
    // 规格 §8：命令失败/输出不可解析 → 回退上一条缓存并标 stale（UI 显示「状态未知」），不抛错。
    // 无缓存时把失败也记进缓存：`pi mcp list` 会真的去连每台 server（可能十几秒），
    // 失败时不该被调用方每次轮询都重试；要重试就显式走 force。
    if (result.commandFailed && this.cache) return { ...this.cache, stale: true };
    this.cache = result;
    return { ...result, stale: false };
  }

  /**
   * 登录态：mcp-auth.json 是否含该 server（名 + URL）的凭据（F19）。
   *
   * 需要 server **名**：pi 1.0.0 起的键带命名空间（`mcp__<name>|<url>`），
   * 只按 URL 查会一律判成未登录（见 {@link mcpAuthKeysOf}）。
   */
  async isSignedIn(serverName: string, serverUrl: string): Promise<boolean> {
    const keys = await readMcpAuthKeys(this.opts.agentDir);
    return mcpAuthKeysOf(keys, serverName, serverUrl) === true;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  /** 是否已有缓存（含失败缓存）：调用方以此区分冷热路径（冷缓存回包不等 pi，见 routes/mcp.ts） */
  cached(): boolean {
    return this.cache !== undefined;
  }

  /**
   * shell out 一次 `pi mcp list --json`。
   * 到 timeoutMs（缺省 {@link DEFAULT_LIST_TIMEOUT_MS}）仍未退出则 kill 子进程并按「命令失败」返回
   * （规格 §8 的失败分支），由 list() 决定是否回退到缓存 —— 调用方永远不会被卡住的 pi 挂住。
   */
  private async runList(): Promise<McpListResult> {
    const proc = Bun.spawn(
      [this.opts.runtime, this.opts.cliPath, "mcp", "list", "--json"],
      {
        cwd: this.opts.cwd,
        env: { ...process.env, PI_CODING_AGENT_DIR: this.opts.agentDir },
        stdout: "pipe",
        // stdout 按 UTF-8 解码（规格 §7）。stderr 直接丢弃：失败原因走 stdout 的 errors[]/error
        // （真 pi 实测，见 tests/mcp-admin-spawn.test.ts）；若留着 "pipe" 不读，任一台 server
        // 刷满 stderr 管道就会把 pi 阻塞在写 stderr 上，只能等超时。
        stderr: "ignore",
      },
    );
    const done = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(
      ([stdout, exitCode]) => ({ stdout, exitCode }),
    );

    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raced = await Promise.race([
        done,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
      if (raced !== null) {
        return parseMcpListOutput(raced.stdout, { exitCode: raced.exitCode });
      }
      // 到点：kill 掉子进程，但**不** await proc.exited —— 连 kill 都杀不动的子进程
      // 不该把调用方继续挂住，这里只保证「不再等它」。
      try {
        proc.kill();
      } catch {
        /* 已经退出 */
      }
      return { servers: [], errors: [], commandFailed: true, hasProblems: true };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
