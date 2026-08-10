// packages/kernel/tests/npm-package-service.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainLines, NpmPackageService } from "../src/npm-package-service";

let dir: string;
beforeEach(() => {
  dir = join(import.meta.dir, ".tmp-npm-svc-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("getInstalledVersion 读取 node_modules 中 package.json 的版本", () => {
  const pkgDir = join(dir, "node_modules", "test-pkg");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "test-pkg", version: "1.2.3" }));

  const svc = new NpmPackageService(dir);
  expect(svc.getInstalledVersion("test-pkg")).toBe("1.2.3");
});

test("getInstalledVersion 包不存在返回 undefined", () => {
  const svc = new NpmPackageService(dir);
  expect(svc.getInstalledVersion("nonexistent")).toBeUndefined();
});

test("getDescription 返回 description 字段", () => {
  const pkgDir = join(dir, "node_modules", "desc-pkg");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "desc-pkg", version: "1.0.0", description: "A test package" }));

  const svc = new NpmPackageService(dir);
  expect(svc.getDescription("desc-pkg")).toBe("A test package");
});

test("构造函数接受自定义 npmCommand 且实际被 spawn 使用", async () => {
  // 验证自定义 npmCommand 透传到 spawn：用一个 PATH 里不存在的命令触发 Bun.spawn 的
  // "Executable not found" 错误——错误信息里包含该命令名，证明 spawn 用的是自定义命令
  // 而非默认 "bun"。
  const customCmd = "this-cmd-does-not-exist-xyz";
  const svc = new NpmPackageService(dir, { npmCommand: [customCmd] });
  expect(svc).toBeDefined();
  try {
    await svc.install("any-pkg");
    // 若走到这里说明 spawn 未抛错（不应该发生），强制失败
    expect.unreachable("expected spawn to fail with Executable not found");
  } catch (err) {
    const msg = (err as Error).message;
    // Bun.spawn 在可执行文件不存在时抛 "Executable not found in $PATH: \"<cmd>\""
    expect(msg).toContain(customCmd);
  }
});

// ===== drainLines: 流式按行回推 =====

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

test("drainLines 按行回调并返回完整文本", async () => {
  const lines: string[] = [];
  const text = await drainLines(streamOf(["解析依赖\n", "下载中\n", "完成\n"]), (l) => lines.push(l));
  expect(lines).toEqual(["解析依赖", "下载中", "完成"]);
  expect(text).toBe("解析依赖\n下载中\n完成\n");
});

test("drainLines 正确处理跨 chunk 边界的行", async () => {
  // 同一行被拆进多个 chunk，换行符也可能落在 chunk 边界
  const lines: string[] = [];
  await drainLines(streamOf(["解析", "依赖\n下载", "-pkg@1.0.0\n"]), (l) => lines.push(l));
  expect(lines).toEqual(["解析依赖", "下载-pkg@1.0.0"]);
});

test("drainLines 处理 CRLF 与无换行结尾的尾行", async () => {
  const lines: string[] = [];
  await drainLines(streamOf(["a\r\nb\r\nc"]), (l) => lines.push(l));
  expect(lines).toEqual(["a", "b", "c"]);
});

test("drainLines 跳过空白行", async () => {
  const lines: string[] = [];
  await drainLines(streamOf(["a\n\n   \nb\n"]), (l) => lines.push(l));
  expect(lines).toEqual(["a", "b"]);
});

test("drainLines null 流返回空串", async () => {
  expect(await drainLines(null, () => {})).toBe("");
});

// 真实路径集成：用 bun -e 打印已知日志行，验证 install 流式回推
test("NpmPackageService.install 把子进程输出按行流式回推", async () => {
  const realDir = mkdtempSync(join(tmpdir(), "npm-svc-"));
  try {
    const script = "console.error('解析依赖'); console.error('下载 demo@1.0.0');";
    const svc = new NpmPackageService(realDir, { npmCommand: ["bun", "-e", script] });
    const lines: string[] = [];
    // 真实环境下 getInstalledVersion 找不到包会抛错；只验证流式行在抛错前已回推
    await expect(
      svc.install("demo", undefined, (l) => lines.push(l)),
    ).rejects.toThrow();
    expect(lines).toEqual(["解析依赖", "下载 demo@1.0.0"]);
  } finally {
    rmSync(realDir, { recursive: true, force: true });
  }
});

// 升级流式回推：与 install 同样的 spawn 机制，验证 upgrade 也按行回推进度
test("NpmPackageService.upgrade 把子进程输出按行流式回推", async () => {
  const realDir = mkdtempSync(join(tmpdir(), "npm-svc-"));
  try {
    const script = "console.error('解析依赖'); console.error('升级 demo@2.0.0');";
    const svc = new NpmPackageService(realDir, { npmCommand: ["bun", "-e", script] });
    const lines: string[] = [];
    await expect(
      svc.upgrade("demo", (l) => lines.push(l)),
    ).rejects.toThrow();
    expect(lines).toEqual(["解析依赖", "升级 demo@2.0.0"]);
  } finally {
    rmSync(realDir, { recursive: true, force: true });
  }
});

// 回归：upgrade 必须用 `add <name>` 而非 `update <name>`。
// bun 默认把精确版本写入 package.json，`update` 只在现有 semver 范围内重新解析，
// 精确版本范围内只有自身 → exit 0 但版本不变（升级静默失败，与 install 用 add 不一致）。
// 用脚本把收到的 args 打印到 stderr，断言第一个 arg 是 "add" 而非 "update"。
test("NpmPackageService.upgrade 用 add 而非 update 强制解析最新版", async () => {
  const realDir = mkdtempSync(join(tmpdir(), "npm-svc-"));
  try {
    // 打印 npmCommand 之后的第一个位置参数（即 add/update 子命令）
    // bun -e <script> add demo → process.argv = [bun, "add", "demo"]
    const script = "console.error(process.argv[1]);";
    const svc = new NpmPackageService(realDir, { npmCommand: ["bun", "-e", script] });
    const lines: string[] = [];
    await expect(svc.upgrade("demo", (l) => lines.push(l))).rejects.toThrow();
    // spawn 把 npmCommand + args 拼接，脚本里 process.argv[2] = 第一个 args（add/update）
    expect(lines[0]).toBe("add");
    expect(lines[0]).not.toBe("update");
  } finally {
    rmSync(realDir, { recursive: true, force: true });
  }
});

// install 超时：子进程挂起时按 opTimeoutMs 终止并报超时错误
// 离线/镜像源不可达时 bun add 会挂起，无超时则前端安装占位永远转圈
test("install 超时：子进程挂起时按 opTimeoutMs 终止并报超时错误", async () => {
	const svc = new NpmPackageService(dir, {
		// bun -e 起一个 30s 空转的假包管理器（多余参数进 argv，不影响脚本执行）
		npmCommand: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
		opTimeoutMs: 300,
	});
	const startedAt = Date.now();
	await expect(svc.install("some-pkg")).rejects.toThrow("超时");
	expect(Date.now() - startedAt).toBeLessThan(5_000);
}, 10_000);
