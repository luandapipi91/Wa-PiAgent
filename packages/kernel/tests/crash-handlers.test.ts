import { test, expect, mock } from "bun:test";
import { installCrashHandlers } from "../src/crash-logger";

// installCrashHandlers：注册 uncaughtException/unhandledRejection 处理器，
// 写崩溃日志 + 广播 error 给前端 + 不退出进程。用 mock process 隔离测试，
// 避免污染真实 bun:test 进程的全局 handler。

function makeMockProcess() {
  const handlers: Record<string, ((...args: any[]) => void)[]> = {};
  return {
    on(event: string, cb: (...args: any[]) => void) {
      (handlers[event] ??= []).push(cb);
    },
    emit(event: string, ...args: any[]) {
      for (const cb of handlers[event] ?? []) cb(...args);
    },
    exit: mock(() => {}),
  } as any;
}

test("installCrashHandlers: unhandledRejection 写日志 + 广播 error + 不 exit", () => {
  const proc = makeMockProcess();
  const logger = {
    uncaughtException: mock(() => {}),
    unhandledRejection: mock(() => {}),
    flush: mock(() => Promise.resolve()),
  };
  const broadcast = mock<(e: { type: string; message: string }) => void>(
    () => {},
  );
  installCrashHandlers(proc, logger as any, broadcast);

  const err = new Error("拒绝");
  proc.emit("unhandledRejection", err);

  expect(logger.unhandledRejection).toHaveBeenCalledTimes(1);
  expect(logger.unhandledRejection).toHaveBeenCalledWith(err);
  // 广播一条 error 事件给前端，让用户看到提示（而非静默崩溃）
  expect(broadcast).toHaveBeenCalledTimes(1);
  const evt = broadcast.mock.calls[0][0];
  expect(evt.type).toBe("error");
  expect(evt.message).toContain("拒绝");
  // 关键：绝不退出进程
  expect(proc.exit).not.toHaveBeenCalled();
});

test("installCrashHandlers: uncaughtException 写日志 + 广播 + 不 exit", () => {
  const proc = makeMockProcess();
  const logger = {
    uncaughtException: mock(() => {}),
    unhandledRejection: mock(() => {}),
    flush: mock(() => Promise.resolve()),
  };
  const broadcast = mock(() => {});
  installCrashHandlers(proc, logger as any, broadcast);

  proc.emit("uncaughtException", new Error("爆炸"));

  expect(logger.uncaughtException).toHaveBeenCalledTimes(1);
  expect(broadcast).toHaveBeenCalledTimes(1);
  expect(proc.exit).not.toHaveBeenCalled();
});

test("installCrashHandlers: 广播失败不影响日志记录（不二次抛错）", () => {
  const proc = makeMockProcess();
  const logger = {
    uncaughtException: mock(() => {}),
    unhandledRejection: mock(() => {}),
    flush: mock(() => Promise.resolve()),
  };
  const broadcast = () => {
    throw new Error("广播也炸了");
  };
  installCrashHandlers(proc, logger as any, broadcast);

  expect(() => proc.emit("unhandledRejection", new Error("x"))).not.toThrow();
  expect(logger.unhandledRejection).toHaveBeenCalled();
});

test("installCrashHandlers: 已知运行时 bug（bun#25633）只写日志、不广播 error", () => {
  const proc = makeMockProcess();
  const logger = {
    uncaughtException: mock(() => {}),
    unhandledRejection: mock(() => {}),
    flush: mock(() => Promise.resolve()),
  };
  const broadcast = mock(() => {});
  installCrashHandlers(proc, logger as any, broadcast);

  // 复现真实堆栈：Bun node:net autoSelectFamily 竞态（oven-sh/bun#25633）
  const err = new TypeError("null is not an object (evaluating 'context')");
  err.stack =
    "TypeError: null is not an object (evaluating 'context')\n    at internalConnectMultipleTimeout (node:net:1128:215)";
  proc.emit("uncaughtException", err);

  // 日志照常留痕（供日后核对触发频率）
  expect(logger.uncaughtException).toHaveBeenCalledTimes(1);
  expect(logger.uncaughtException).toHaveBeenCalledWith(err);
  // 不广播：避免注入对话流 + failTurn 打断进行中的回复
  expect(broadcast).not.toHaveBeenCalled();
  // 关键：绝不退出进程
  expect(proc.exit).not.toHaveBeenCalled();
});

test("installCrashHandlers: 堆栈含 internalConnectMultipleTimeout 但 message 不匹配 → 照常广播", () => {
  const proc = makeMockProcess();
  const logger = {
    uncaughtException: mock(() => {}),
    unhandledRejection: mock(() => {}),
    flush: mock(() => Promise.resolve()),
  };
  const broadcast = mock<(e: { type: string; message: string }) => void>(
    () => {},
  );
  installCrashHandlers(proc, logger as any, broadcast);

  // 真实网络错误（同堆栈、不同 message）不应被误判为已知 bug
  const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
  err.stack =
    "Error: connect ECONNREFUSED 127.0.0.1:443\n    at internalConnectMultipleTimeout (node:net:1128:215)";
  proc.emit("uncaughtException", err);

  expect(logger.uncaughtException).toHaveBeenCalledTimes(1);
  expect(broadcast).toHaveBeenCalledTimes(1);
  expect(broadcast.mock.calls[0][0].message).toContain("ECONNREFUSED");
  expect(proc.exit).not.toHaveBeenCalled();
});
