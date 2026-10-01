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
 * `timeoutSec` 的上限（秒）。
 *
 * 不只是「别等太久」：`setTimeout` 的延时超过 2^31−1 ms 会被运行时**截断成 1ms**（实测
 * `TimeoutOverflowWarning: 1000000015000 does not fit into a 32-bit signed integer.
 * Timeout duration was set to 1.`），于是用户传一个超大值反而让 pi 刚 spawn 就被 SIGTERM，
 * 前端只看到「pi 没有输出原因」这种误诊我们自己的错的文案；另一端，10^6 秒量级（11 天）的
 * 定时器又是正常的，子进程与它的 `127.0.0.1:<端口>/callback` 监听会一直活着。
 *
 * 取 1 小时：足够在浏览器里走完一次授权，又保证 `(timeoutSec + LOGIN_KILL_GRACE_SEC) * 1000`
 * 恒在 2^31−1 内（同 rpc-client.ts 的 Infinity 特判 / subagent-runner.ts 的同款注释）。
 */
export const MAX_LOGIN_TIMEOUT_SEC = 3600;

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

/** `setTimeout` 能接受的最大延时；超过它会被截断成 1ms（见 {@link MAX_LOGIN_TIMEOUT_SEC}） */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * 到点 kill 之后，留给进程收尾（真正退出）的窗口；超时就用 SIGKILL 升级。
 *
 * SIGTERM 之后进程通常毫秒级退出，500ms 是给「卡在慢系统调用里」的情况留的余量。
 */
const KILL_SETTLE_MS = 500;

/**
 * 进程已经退出/已被杀之后，再等管道读完（stderr 与 stdout 的尾巴）的窗口。
 *
 * 正常路径是瞬时的（进程退出即管道关闭）；只有在写端被别的进程攥着不放时才需要这点耐心，
 * 给不出就用手上已读到的输出——绝不能因为管道不收尾把调用方挂住。
 */
const PIPE_SETTLE_MS = 500;

/** 把毫秒数收进 `setTimeout` 的安全区（见 {@link MAX_LOGIN_TIMEOUT_SEC}）；路由已按上限挡过，这里再兜一次底 */
function clampTimerMs(ms: number): number {
  return Math.min(ms, MAX_TIMER_MS);
}

/** 等 p 在 ms 内兼现；超时返回 false。无论走哪条路都清掉定时器，不留下悬挂的句柄 */
async function waitFor(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

/** 子进程执行器真正用到的那点接口（真实现 = `Bun.spawn` 的返回；测试可注入假件，见 {@link McpLoginSpawnOpts.spawnImpl}） */
export interface McpLoginProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  /** 退出码（进程未退出时永不兼现） */
  exited: Promise<number>;
  exitCode: number | null;
  /** 不带参数 = SIGTERM（同 Bun 的语义）；SIGKILL 是「连 SIGTERM 都不理」时的第二道防线 */
  kill(signal?: "SIGKILL"): void;
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
  /**
   * 覆盖子进程创建（**只给测试用**，生产不传）。
   *
   * 为什么需要这个缝：「stdout 已关但进程还活着」是宽限 kill 唯一需要生效的场景，而 Bun 的
   * 子进程会自己攥着 stdout 管道直到退出（实测 `process.stdout.end()` / `closeSync(1)` 都不产生
   * 父进程侧的 EOF），所以真子进程假 pi 造不出这个现场。注入的只是一个子进程对象，被测的
   * 仍然是真的 `McpLoginRunner`（读循环、截止时间、kill 与收场全是真的）。
   */
  spawnImpl?: (args: string[]) => McpLoginProcess;
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
   *
   * 无论如何**有上界**：不管 stdout 开还是关、进程退还是不退，最多
   * `timeoutSec + 宽限` + kill 收尾两个窗口 + 读干管道一个窗口就返回。
   */
  async run(input: LoginRunInput): Promise<LoginRunResult> {
    const proc = this.spawn(["mcp", "login", input.server, "--timeout", String(input.timeoutSec)]);
    if (!proc) {
      return { ok: false, url: null, output: "无法启动 pi 进程（pi mcp login）" };
    }

    let out = "";
    let stderr = "";
    // 读 stdout（逐行转发给 SSE）与立刻排空 stderr（不读的话 pi 刷满 stderr 管道就会阻塞在写上，
    // McpAdmin 同款考虑）——两者与「等退出」**并行**：stdout 关闭不等于进程会退出。
    const pump = (async () => {
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
      } catch {
        /* 管道被中断（进程被杀 / 读端出错）：保留已读到的输出，成败以退出码与是否被我们杀掉为准 */
      }
    })();
    const settled = Promise.all([
      pump,
      new Response(proc.stderr).text().then(
        (t) => {
          stderr = t;
        },
        () => undefined,
      ),
      proc.exited.then(() => undefined),
    ]);

    const graceSec = this.opts.killGraceSec ?? LOGIN_KILL_GRACE_SEC;
    // 上界：`--timeout` 之外再给一点宽限，到点就 kill 它。
    // 关键：这个上界必须盯在**进程退出**上，而不是「stdout 读完」——pi 关掉 stdout 却不退出
    // （回调端口被占、卡在系统调用里）时，读循环会先结束，若把安全网挂在读循环的 finally 上，
    // 随后的等待就无上界了：终端事件不发、缓存不失效、前端永远停在「等待授权」。
    let killed = false;
    if (!(await waitFor(proc.exited, clampTimerMs((input.timeoutSec + graceSec) * 1000)))) {
      killed = proc.exitCode === null; // 已经自己退了、只是管道还被捏着：不算我们杀的
      if (killed) await this.terminate(proc);
    }
    const exitCode = proc.exitCode;
    // 到点之后**不再**无限等 proc.exited（terminate 自己也只等两个窗口）：连 kill 都杀不动的
    // 子进程不该把调用方继续挂住（McpAdmin.runList 同款取舍）。这里只再等管道读完。
    await waitFor(settled, PIPE_SETTLE_MS);
    // 凭据已经落盘（或已经确认没落盘）→ 下一次 list 必须重跑 `pi mcp list`
    this.admin.invalidate();
    const output = [out, stderr].filter(Boolean).join("\n");
    return {
      ok: !killed && exitCode === 0,
      url: extractAuthorizationUrl(output),
      output,
    };
  }

  /**
   * 执行 logout：删 `<agent-dir>/mcp-auth.json` 里该 server 的凭据条目（F19），随后失效状态缓存
   */
  async logout(server: string): Promise<LogoutRunResult> {
    const proc = this.spawn(["mcp", "logout", server]);
    if (!proc) {
      return { ok: false, output: "无法启动 pi 进程（pi mcp logout）" };
    }
    let stdout = "";
    let stderr = "";
    const settled = Promise.all([
      new Response(proc.stdout).text().then(
        (t) => {
          stdout = t;
        },
        () => undefined,
      ),
      new Response(proc.stderr).text().then(
        (t) => {
          stderr = t;
        },
        () => undefined,
      ),
      proc.exited.then(() => undefined),
    ]);

    // 与 login 同一取舍：到点 kill 之后不再无限等它——logout 被路由 await，挂住就是真挂住一个
    // HTTP 请求（前端只能等到自己的请求超时）。kill 的后备同理（SIGTERM → SIGKILL）。
    let killed = false;
    if (!(await waitFor(proc.exited, LOGOUT_TIMEOUT_MS))) {
      killed = proc.exitCode === null;
      if (killed) await this.terminate(proc);
    }
    const exitCode = proc.exitCode;
    // 收尾读干管道（正常路径瞬时；进程已死而管道被攥着时不超 PIPE_SETTLE_MS）
    await waitFor(settled, PIPE_SETTLE_MS);
    // 无论成败都失效：pi 可能已经删掉了条目才报错（如删完退出码非 0），下一次 list 必须重读
    this.admin.invalidate();
    return {
      ok: !killed && exitCode === 0,
      output: [stdout, stderr].filter(Boolean).join("\n").trim(),
    };
  }

  /**
   * 先 SIGTERM；{@link KILL_SETTLE_MS} 内没退出再升级 SIGKILL（同 rpc-client.dispose 的两道防线：
   * pi 卡在不可中断的调用里时 SIGTERM 会被忽略），两道都不生效就**不再等它**。
   */
  private async terminate(proc: McpLoginProcess): Promise<void> {
    this.signal(proc, undefined);
    if (await waitFor(proc.exited, KILL_SETTLE_MS)) return;
    this.signal(proc, "SIGKILL");
    await waitFor(proc.exited, KILL_SETTLE_MS);
  }

  /** 发信号；进程已退出 / 杀不动都只当无事发生（回收失败不能把调用方带崩） */
  private signal(proc: McpLoginProcess, signal: "SIGKILL" | undefined): void {
    try {
      if (signal) proc.kill(signal);
      else proc.kill();
    } catch {
      /* 已经退出 */
    }
  }

  /** spawn 一次 pi 子进程；启动失败（运行时不存在等）返回 null，不抛错 */
  private spawn(args: string[]): McpLoginProcess | null {
    if (this.opts.spawnImpl) {
      try {
        return this.opts.spawnImpl(args);
      } catch {
        return null;
      }
    }
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
