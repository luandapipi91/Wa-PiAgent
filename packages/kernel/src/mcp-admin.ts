// McpAdmin：MCP 运行状态的**唯一读取者**（规格 §3、§7）。
//
// 本模块自己**不连** MCP —— 只 shell out `pi mcp list --json` 并解析那条 JSON（F14）。
// 盘上配置的写入归 mcp-file.ts、受信归 mcp-trust.ts：这里是只读面。
import type { McpExposure } from "@wa-pi/shared";

/**
 * server URL → pi 存在 mcp-auth.json 里的键。
 *
 * pi 用 `String(new URL(url))` 规范化后当键：主机名小写、默认端口省略、无路径 URL 补尾斜杠。
 * 拿配置里原样的字符串去查就会漏判（`https://Host:443` 与盘上的 `https://host/` 不是一个键），
 * 而登录 UI 的「已登录 / 未登录」完全靠这个判断。
 *
 * 非 URL（含 `undefined`/空串/任意非 URL 文本）→ null：调用方一律按「未登录」处理。
 */
export function normalizeMcpAuthKey(url: string): string | null {
  try {
    return String(new URL(url));
  } catch {
    return null;
  }
}

/**
 * 读 `<agentDir>/mcp-auth.json` 的键集合（规范化后）。
 *
 * 一次性读整份文件供多处比对（列表里每台 HTTP server 都要问一次登录态，逐台重读文件没必要）。
 * 文件缺失 / 非 JSON / 不是「URL → 凭据」的 map → 空集合（不抛错，F19）；
 * 用 `Object.keys` 而不是 `in`，避免把原型链上的键（`toString` 等）当成凭据。
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

/** `pi mcp list` 的缺省等待上限（毫秒）：一个卡住的 server 不该把 GUI 的 MCP 页永久挂住 */
export const DEFAULT_LIST_TIMEOUT_MS = 30_000;

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

  /** 登录态：mcp-auth.json 是否含该 server URL 的条目（F19） */
  async isSignedIn(serverUrl: string): Promise<boolean> {
    const key = normalizeMcpAuthKey(serverUrl);
    if (!key) return false; // 不是 URL（`toString` 之类的原型链键也在这一步被挡掉）
    return (await readMcpAuthKeys(this.opts.agentDir)).has(key);
  }

  invalidate(): void {
    this.cache = undefined;
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
