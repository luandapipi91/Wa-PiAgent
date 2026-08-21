import { test, expect, mock } from "bun:test";
import { installCrashHandlers } from "../src/crash-logger";

// installCrashHandlers：注册 uncaughtException/unhandledRejection 处理器，
// 写崩溃日志 + 广播 error 给前端 + 不退出进程。用 mock process 隔离测试，
// 避免污染真实 bun:test 进程的全局 handler。

function makeMockProcess() {
  const handlers: Record<string, ((...args: any[]) => void)[]> = {};
  return {
    on(event: string, cb: (...args: any[]) => void) {
      handlers[event] ??= [];
      handlers[event].push(cb);
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

