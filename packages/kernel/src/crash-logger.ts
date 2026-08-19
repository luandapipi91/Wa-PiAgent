// crash-logger.ts — kernel 未捕获异常/unhandledRejection 的崩溃日志（跟踪用）
//
// 背景：kernel 是独立 bun 子进程，desktop 侧只能捕获它的 stdout/stderr。
// 历史 bug 中 kernel 被 Bun 因未捕获异常杀死（日志仅 退出 code=null，无堆栈），
// 无法定位根因。本模块把异常堆栈追加写入 ~/.pi/agent/logs/kernel-crash.log，
// 供后续排查。写入静默吞错——日志失败绝不能反过来再杀进程。

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** 把任意值格式化为可记录的字符串（含堆栈） */
function formatReason(reason: unknown): string {
 if (reason instanceof Error)
  return reason.stack ?? `${reason.name}: ${reason.message}`;
 if (typeof reason === "string") return reason;
 try {
  return JSON.stringify(reason);
 } catch {
  return String(reason);
 }
}

export interface CrashLogger {
 /** 记录 uncaughtException */
 uncaughtException(reason: unknown): void;
 /** 记录 unhandledRejection */
 unhandledRejection(reason: unknown): void;
 /** 等齐所有 in-flight 写入（测试/退出前用） */
 flush(): Promise<void>;
}

/** 最小 process 形状（便于测试注入 mock） */
interface ProcessLike {
 on(event: string, cb: (...args: any[]) => void): void;
 exit(code?: number): void;
}

/**
 * 创建崩溃日志记录器。
 * @param logPath 日志文件绝对路径（目录自动创建）
 */
export function createCrashLogger(logPath: string): CrashLogger {
 const pending = new Set<Promise<unknown>>();
 const write = (
  type: "uncaughtException" | "unhandledRejection",
  reason: unknown,
 ) => {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${type}: ${formatReason(reason)}\n`;
  const p = mkdir(dirname(logPath), { recursive: true })
   .then(() => appendFile(logPath, line))
   .catch(() => {}); // 日志写失败静默吞错，绝不反向杀进程
  pending.add(p);
  p.finally(() => pending.delete(p));
 };
 return {
  uncaughtException: (reason) => write("uncaughtException", reason),
  unhandledRejection: (reason) => write("unhandledRejection", reason),
  flush: () => Promise.allSettled([...pending]).then(() => {}),
 };
}

/**
 * 已知的运行时无害 bug 白名单：命中则只写日志、不广播 error。
 *
 * 背景：部分底层运行时（Bun）自身的竞态 bug 会以 uncaughtException 形式冒泡，
 * 但业务无实际影响（有兜底重试/超时路径）。若照常广播 error，前端会把它注入
 * 对话流并 failTurn 打断正在进行的回复（oven-sh/bun#25633：autoSelectFamily
 * 连接超时回调访问已置 null 的 context，1.3.15+ 修复）。对这类已知 bug 降级为
 * 静默留痕，避免用户被误导为「内核崩溃」且对话被无故打断。
 *
 * 匹配必须同时满足 message + stack，防止误吞真实异常。
 */
const KNOWN_BENIGN_RUNTIME_BUGS: ReadonlyArray<{
 matchMessage: RegExp;
 matchStack: RegExp;
}> = [
 {
  // Bun node:net autoSelectFamily (Happy Eyeballs) 竞态：
  // internalConnectMultipleTimeout 定时器回调访问已置 null 的 context
  matchMessage: /null is not an object \(evaluating 'context'\)/,
  matchStack: /internalConnectMultipleTimeout/,
 },
];

/** 判断是否为已知的运行时无害 bug（message + stack 双重匹配） */
function isKnownBenignRuntimeBug(reason: unknown): boolean {
 if (!(reason instanceof Error)) return false;
 return KNOWN_BENIGN_RUNTIME_BUGS.some(
  (b) =>
   b.matchMessage.test(reason.message) &&
   (reason.stack ? b.matchStack.test(reason.stack) : false),
 );
}

/**
 * 注册全局异常处理器：把 uncaughtException / unhandledRejection 写入崩溃日志、
 * 广播一条 error 给前端，并**绝不退出进程**。
 *
 * 背景：bun 默认对未捕获 rejection 终止进程（与 Node 不同）。kernel 任何异步分支
 * 未 catch 都会杀死进程（历史 bug：发消息回复部分内容后 SSE 断开，日志仅 code=null）。
 * 本处理器兜底所有未捕获异常，让进程存活、留痕日志、提示用户。
 *
 * 对 KNOWN_BENIGN_RUNTIME_BUGS 白名单内的已知运行时 bug：照常写日志，但
 * 不广播 error（避免前端注入对话流 + failTurn 打断进行中的回复），仅 stderr warn 留痕。
 *
 * @param proc      process（或测试 mock）
 * @param logger    崩溃日志记录器
 * @param broadcast 广播回调（可能为 null——server 未就绪时）；内部隔离其异常
 */
export function installCrashHandlers(
 proc: ProcessLike,
 logger: CrashLogger,
 broadcast: ((e: { type: "error"; message: string }) => void) | null,
): void {
 const handle = (
  type: "uncaughtException" | "unhandledRejection",
  loggerFn: (r: unknown) => void,
  reason: unknown,
 ) => {
  try {
   loggerFn(reason);
  } catch {
   /* 日志本身失败也不能反向杀进程 */
  }
  try {
   // 已知运行时无害 bug：只留痕（已写日志 + stderr warn），不广播 error，
   // 避免前端注入对话流 + failTurn 打断进行中的回复。
   if (isKnownBenignRuntimeBug(reason)) {
    console.warn(
     `[crash] ${type} 已知运行时 bug（已记录日志，不广播）：${reason instanceof Error ? reason.message : String(reason)}`,
    );
    return;
   }
   const msg = reason instanceof Error ? reason.message : String(reason);
   broadcast?.({ type: "error", message: `内核异常（${type}）：${msg}` });
  } catch {
   /* 广播失败不影响日志 */
  }
  // 关键：不调 proc.exit，让进程存活
 };
 proc.on("uncaughtException", (reason) =>
  handle("uncaughtException", (r) => logger.uncaughtException(r), reason),
 );
 proc.on("unhandledRejection", (reason) =>
  handle("unhandledRejection", (r) => logger.unhandledRejection(r), reason),
 );
}
