// MCP OAuth 登录 / 登出（规格 F19/F20）：图形化承接 `pi mcp login|logout`。
//
// 为什么 shell out 而不在 kernel 里自己实现 OAuth：pi 内置的 MCP 扩展已经把整条链做完了
// （POST /mcp 得 401 → 读 WWW-Authenticate 的 resource_metadata → 元数据发现 → 动态客户端
// 注册 → PKCE → 把授权 URL 打到 stdout → 本机 127.0.0.1:<随机端口>/callback 收授权码），
// 凭据也由它写进 `<agent-dir>/mcp-auth.json`（键 = 规范化后的 server URL，F19）。
// GUI 的职责只有三件：发起、把 pi 打到 stdout 的授权 URL 转给前端、结束后刷新状态。
//
// pi 的两个实测行为决定了这里的形态（POC，规格 §11）：
//   · **非 TTY 下不卡死**：授权 URL 打到 stdout，到 `--timeout` 后报 cancelled 并退出
//     ——所以「超时」是一条正常返回路径，不是异常；
//   · **它会自己打开系统默认浏览器且无法抑制** ——所以前端拿到 URL 后只展示、不自动再打开
//     （否则必然是两个标签页，见 components/mcp/McpCard.tsx）。
import { stripAnsi } from "./rpc-client.ts";
import type { McpAdmin } from "./mcp-admin.ts";

/** 前端没有指定超时秒数时用的缺省值（够用户在浏览器里走完一次授权） */
export const DEFAULT_LOGIN_TIMEOUT_SEC = 300;

/**
 * 在 pi 自己的 `--timeout` 之外多留的宽限（秒）。
 *
 * 正常路径用不到它：pi 到点会自己退出并报 cancelled。它兜的是「pi 卡住不退出」（回调端口被占、
 * 网络请求挂住等）——没有它，那次登录会永远停在「等待授权」，与 McpAdmin 的 timeoutMs
 * 护栏是同一个考虑：调用方永远不该被卡住的 pi 挂住。
 */
export const LOGIN_KILL_GRACE_SEC = 15;

/**
 * `pi mcp logout` 的等待上限（毫秒）。
 *
 * logout 只删本地 mcp-auth.json 的一个条目、不碰网络，正常在秒级完成。上限取 20s 而不是
 * 前端 api-client 的 30s：留出余量让 kernel 先返回一条**可读的**错误，而不是让前端超时后
 * 只报一句「请求超时」。
 */
export const LOGOUT_TIMEOUT_MS = 20_000;

/** 从 `pi mcp login` 的 stdout 中提取授权 URL（F20：非 TTY 下 URL 打到 stdout） */
export function extractAuthorizationUrl(stdout: string): string | null {
  // 先剥 ANSI：pi 的输出可能带终端着色，转义码会粘在 URL 尾巴上（\S+ 会把它们一起吞进来）
  for (const line of stripAnsi(stdout).split(/\r?\n/)) {
    const m = line.match(/https?:\/\/\S+/);
    if (m) return m[0];
  }
  return null;
}

/**
 * 输出里最后一条非空行。
 *
 * pi 把失败原因（超时 cancelled / 不支持 OAuth / 连不上）打在末尾，而 stdout 前面的说明行
 * （"Sign in to MCP server …"）不能当错误文案，所以取末行而不是首行。剥 ANSI、去空白；
 * 全是空白时返回空串（调用方自己兜底文案）。
 */
export function lastNonEmptyLine(output: string): string {
  const lines = stripAnsi(output).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

/** 子进程的 spawn 参数（runtime/cliPath 与 rpc-client 同一解析；agentDir = pi 的配置与凭据目录） */
export interface McpLoginSpawnOpts {
  runtime: string;
  cliPath: string;
  agentDir: string;
  /** 子进程的工作目录：决定 pi 读哪个作用域（全局 / 项目）的 MCP 配置 */
  cwd: string;
  /**
   * 「pi 卡住不退出」时在 `--timeout` 之外多等的秒数，缺省 {@link LOGIN_KILL_GRACE_SEC}。
   * 可注入是给测试用（真等 15s 的用例太贵）；生产不传。
   */
  killGraceSec?: number;
}

export interface LoginRunInput {
  server: string;
  timeoutSec: number;
  /** 逐行回调（stdout 的非空行，已剥 ANSI）——路由把它转成 SSE 事件 */
  onLine: (line: string) => void;
}

export interface LoginRunResult {
  ok: boolean;
  /** 从输出里提取到的授权 URL；失败也交出来（超时前 pi 可能已经打过 URL，用户仍可手动访问） */
  url: string | null;
  /** pi 的完整输出（stdout + stderr），失败时用 {@link lastNonEmptyLine} 取错误文案 */
  output: string;
}

export interface LogoutRunResult {
  ok: boolean;
  output: string;
}

/** 登录 / 登出子进程的执行器（凭据落盘后由它失效状态缓存，F19） */
export class McpLoginRunner {
  constructor(
    /** 只需失效能力：登录会改变 pi 报的 state（needs-auth → connected）与工具清单 */
    private admin: Pick<McpAdmin, "invalidate">,
    private opts: McpLoginSpawnOpts,
  ) {}

  /**
   * 流式执行 login：stdout 逐行回调（授权 URL 就在其中），结束后使状态缓存失效。
   *
   * 不抛错：spawn 失败（运行时/CLI 不存在）也按 `ok:false` 返回，由路由转成 SSE 错误事件
   * ——登录是「回包后才有结果」的长任务，异常没有别的出口。
   */
  async run(input: LoginRunInput): Promise<LoginRunResult> {
    const proc = this.spawn(["mcp", "login", input.server, "--timeout", String(input.timeoutSec)]);
    if (!proc) {
      return { ok: false, url: null, output: "无法启动 pi 进程（pi mcp login）" };
    }

    // 立刻开始排空 stderr：留着不读的话，pi 刷满 stderr 管道就会阻塞在写上（McpAdmin 同款考虑）
    const errText = new Response(proc.stderr).text();
    let out = "";
    let killed = false;
    const timer = setTimeout(
      () => {
        // 退出码就绪 = 已经自己退出（可能是刚好卡在超时点上），那就不是我们杀的
        if (proc.exitCode !== null) return;
        killed = true;
        try {
          proc.kill();
        } catch {
          /* 已经退出 */
        }
      },
      (input.timeoutSec + (this.opts.killGraceSec ?? LOGIN_KILL_GRACE_SEC)) * 1000,
    );

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // stream:true：多字节字符被切成两个 chunk 时不产出替换字符（URL 是 ASCII，但说明行是任意文本）
        const text = decoder.decode(value, { stream: true });
        out += text;
        for (const line of text.split(/\r?\n/)) {
          const clean = stripAnsi(line).trim();
          if (clean) input.onLine(clean);
        }
      }
      out += decoder.decode();
    } finally {
      clearTimeout(timer);
    }

    const [stderr, exitCode] = await Promise.all([errText, proc.exited]);
    // 凭据已经落盘（或已经确认没落盘）→ 下一次 list 必须重跑 `pi mcp list`
    this.admin.invalidate();
    const output = [out, stderr].filter(Boolean).join("\n");
    return {
      ok: !killed && exitCode === 0,
      url: extractAuthorizationUrl(output),
      output,
    };
  }

  /** 执行 logout：删 `<agent-dir>/mcp-auth.json` 里该 server 的凭据条目（F19），随后失效状态缓存 */
  async logout(server: string): Promise<LogoutRunResult> {
    const proc = this.spawn(["mcp", "logout", server]);
    if (!proc) {
      return { ok: false, output: "无法启动 pi 进程（pi mcp logout）" };
    }
    let killed = false;
    const timer = setTimeout(() => {
      if (proc.exitCode !== null) return;
      killed = true;
      try {
        proc.kill();
      } catch {
        /* 已经退出 */
      }
    }, LOGOUT_TIMEOUT_MS);
    let output = "";
    let exitCode = 1;
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      output = [stdout, stderr].filter(Boolean).join("\n").trim();
      exitCode = code;
    } finally {
      clearTimeout(timer);
    }
    // 无论成败都失效：pi 可能已经删掉了条目才报错（如删完退出码非 0），下一次 list 必须重读
    this.admin.invalidate();
    return { ok: !killed && exitCode === 0, output };
  }

  /** spawn 一次 pi 子进程；启动失败（运行时不存在等）返回 null，不抛错 */
  private spawn(args: string[]): Bun.Subprocess<"ignore", "pipe", "pipe"> | null {
    try {
      return Bun.spawn([this.opts.runtime, this.opts.cliPath, ...args], {
        cwd: this.opts.cwd,
        // PI_CODING_AGENT_DIR：让子进程用与 kernel 同一份配置与凭据（mcp.json / mcp-auth.json 都在那里）
        env: { ...process.env, PI_CODING_AGENT_DIR: this.opts.agentDir },
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      return null;
    }
  }
}
