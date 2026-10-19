// rpc-client-epipe.test.ts — 对已死进程写入（EPIPE）必须立即 reject
//
// 背景（2026-10-08 事故）：pi 进程死亡瞬间的写入（stdin pipe 已断）在
// rpc-client.command 里 write() 不抛错 → Promise 挂起直到 60s 命令超时才 reject，
// 上层（prompt/steer/abort）全部 hang，前端零反馈。
// 目标行为：write 的错误回调（EPIPE）触发时立即 reject 该命令；60s 命令超时
// 保持不变（兜住「进程活着但永不回应」的场景）。
//
// 测试用假 spawnFn 注入「写入异步回调报 EPIPE」的假 stdin（Bun FileSink 的
// write 忽略回调参数，真实环境的兜底是 command 开头的 isAlive 检查、写入后
// 存活复查、onProcExit reject 全部 pending 与 60s 超时——分层防御，本用例
// 锁定的是「写失败路径有 reject 通道」这一层）。
import { test, expect } from "bun:test";
import { RpcClient, type SpawnFn } from "../src/rpc-client";

function makeBrokenPipeProc() {
	const emptyStream = () =>
		new ReadableStream<Uint8Array>({ start(c) {
			c.close();
		} });
	const writes: string[] = [];
	const proc = {
		stdin: {
			// Node 风格 write(data, cb)：cb 异步报 EPIPE
			write(data: string, cb?: (err: Error | null) => void) {
				writes.push(data);
				if (cb) setTimeout(() => cb(new Error("EPIPE: broken pipe")), 5);
				return data.length;
			},
		},
		stdout: emptyStream(),
		stderr: emptyStream(),
		exited: new Promise<number>(() => {}), // 永不退出：exitCode 恒 null（isAlive 通过）
		exitCode: null,
		signalCode: null,
		kill: () => {},
	};
	const spawnFn = (() => proc) as unknown as SpawnFn;
	return { spawnFn, writes };
}

test("对已死进程写入 EPIPE → 立即 reject 而非等 60s 超时", async () => {
	const { spawnFn, writes } = makeBrokenPipeProc();
	const client = new RpcClient({
		cliPath: "pi-cli-dummy",
		runtime: "bun-dummy",
		cwd: "/tmp",
		onEvent: () => {},
		spawnFn,
		// 60s 命令超时保持不变：EPIPE 必须先于它 reject
		commandTimeoutMs: 60_000,
	});
	await client.start();

	const outcome = await Promise.race([
		client
			.command({ type: "prompt" })
			.then(
				() => "resolved",
				(e) => `rejected:${(e as Error).message}`,
			),
		new Promise<string>((r) => setTimeout(() => r("still-pending"), 500)),
	]);
	expect(writes.length).toBe(1); // 写入确实发生了
	expect(outcome).toContain("rejected"); // 此前（红）："still-pending"
	expect(outcome).toContain("EPIPE"); // reject 携带写失败原因，非 60s 超时文案
});
