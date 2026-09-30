// McpAdmin：MCP 运行状态的**唯一读取者**（规格 §3、§7）。
//
// 本模块自己**不连** MCP —— 只 shell out `pi mcp list --json` 并解析那条 JSON（F14）。
// 盘上配置的写入归 mcp-file.ts、受信归 mcp-trust.ts：这里是只读面。
import type { McpExposure } from "@wa-pi/shared";

/** 单台服务器的运行时状态（`pi mcp list --json` 的 servers[] 条目） */
export interface McpServerStatus {
  name: string;
  scope: string;
  source?: string;
  enabled: boolean;
  exposure: McpExposure;
  transport?: string;
  state: "connected" | "failed" | string;
  tools: string[];
  error?: string;
}

export interface McpListResult {
  servers: McpServerStatus[];
  errors: string[];
  /** 命令本身没跑起来/输出不可解析 */
  commandFailed: boolean;
  /** 有 server 处于异常态 */
  hasProblems: boolean;
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
      servers?: McpServerStatus[];
      errors?: string[];
    };
    const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
    return {
      servers,
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      commandFailed: false,
      hasProblems:
        servers.some((s) => s.state !== "connected") ||
        (parsed.errors?.length ?? 0) > 0,
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

export interface McpAdminOpts {
  /** pi 可执行体与 CLI 路径（与 rpc-client 同一解析） */
  runtime: string;
  cliPath: string;
  agentDir: string;
  cwd: string;
  /**
   * `pi mcp list` 的等待上限。缺省不设超时（照 pi 自己的节奏等）。
   * 接线方**必须**传：list 会真的去连每台 server，缺少上限时一个卡住的 server
   * 就能把调用方（GUI 的 MCP 页）永远挂住。
   */
  timeoutMs?: number;
}

export class McpAdmin {
  private cache?: McpListResult;

  constructor(private opts: McpAdminOpts) {}

  async list(force = false): Promise<McpListResult & { stale: boolean }> {
    if (!force && this.cache) return { ...this.cache, stale: false };
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
    try {
      const raw = await Bun.file(`${this.opts.agentDir}/mcp-auth.json`).json();
      // 文件缺失/损坏 → false（不抛错）；用 hasOwn 而非 in，避免命中原型链上的键
      return Boolean(
        raw && typeof raw === "object" && Object.hasOwn(raw, serverUrl),
      );
    } catch {
      return false;
    }
  }

  invalidate(): void {
    this.cache = undefined;
  }

  /**
   * shell out 一次 `pi mcp list --json`。
   * 到 timeoutMs 仍未退出则 kill 子进程并按「命令失败」返回（规格 §8 的失败分支），
   * 由 list() 决定是否回退到缓存 —— 调用方永远不会被卡住的 pi 挂住。
   */
  private async runList(): Promise<McpListResult> {
    const proc = Bun.spawn(
      [this.opts.runtime, this.opts.cliPath, "mcp", "list", "--json"],
      {
        cwd: this.opts.cwd,
        env: { ...process.env, PI_CODING_AGENT_DIR: this.opts.agentDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    // stdout 按 UTF-8 解码（规格 §7）。stderr 收进管道但不读：正常路径 pi 不写 stderr；
    // 若有 server 狂刷 stderr 把管道写满，也只是走到下面的超时分支，不会挂死调用方。
    const done = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(
      ([stdout, exitCode]) => ({ stdout, exitCode }),
    );

    const timeoutMs = this.opts.timeoutMs;
    if (!(typeof timeoutMs === "number" && timeoutMs > 0)) {
      const { stdout, exitCode } = await done;
      return parseMcpListOutput(stdout, { exitCode });
    }

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
