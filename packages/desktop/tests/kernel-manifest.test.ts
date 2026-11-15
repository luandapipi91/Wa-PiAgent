// kernel-manifest 一致性校验纯函数测试：全部走 tmpdir fixture，绝不触达安装目录。
// 背景（2026-11-15 事故）：NSIS 升级覆盖安装时 WaPiKernel.exe 被静默跳过未替换，
// 壳 0.10.3 / 核 0.10.1 共存，内置 agent-browser MCP 等内核功能全部静默缺失。
// 打包时随 resources/kernel/manifest.json 落盘校验清单，应用启动时逐项比对，
// 不一致必须给出结构化 verdict（供日志与用户弹窗），绝不能静默放行。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkKernelConsistency } from "../src/util/kernel-manifest.cjs";

/** 校验结果窄化：ok=false 分支的字段访问辅助（TS 联合类型收窄） */
type FailVerdict = {
	ok: false;
	reason: string;
	expected?: any;
	actual?: any;
};

/** 造一个临时 kernel 目录：manifest + 指定大小的假 exe。
 *  manifestSize 独立于 exeSize：size-mismatch 用例需要「清单声称的大小 ≠ 实际大小」。 */
function fixture(opts?: {
	manifest?: object | string | null; // undefined=默认合法清单；string=写损坏内容；null=不写
	exeSize?: number;
	manifestSize?: number;
	exeMissing?: boolean;
	version?: string;
}) {
	const dir = mkdtempSync(join(tmpdir(), "wa-pi-km-"));
	mkdirSync(dir, { recursive: true });
	const version = opts?.version ?? "0.10.3";
	const exeSize = opts?.exeSize ?? 1000;
	const manifestSize = opts?.manifestSize ?? exeSize;
	const exePath = join(dir, "WaPiKernel.exe");
	if (!opts?.exeMissing) {
		writeFileSync(exePath, Buffer.alloc(exeSize));
	}
	if (opts?.manifest !== null) {
		const content =
			opts?.manifest === undefined
				? JSON.stringify({
						version,
						exe: { name: "WaPiKernel.exe", size: manifestSize, sha256: "x" },
					})
				: typeof opts?.manifest === "string"
					? opts?.manifest
					: JSON.stringify(opts?.manifest);
		writeFileSync(join(dir, "manifest.json"), content);
	}
	return {
		dir,
		manifestPath: join(dir, "manifest.json"),
		exePath,
		appVersion: version, // 默认 app 版本与清单一致 = 全对齐
	};
}

test("全对齐（version 一致 + exe 大小一致）→ ok", () => {
	const f = fixture();
	const v = checkKernelConsistency({
		manifestPath: f.manifestPath,
		exePath: f.exePath,
		appVersion: f.appVersion,
	});
	expect(v.ok).toBe(true);
});

test("manifest 缺失（老版本包/手工删除）→ manifest-missing", () => {
	const f = fixture({ manifest: null });
	const v = checkKernelConsistency({
		manifestPath: f.manifestPath,
		exePath: f.exePath,
		appVersion: f.appVersion,
	}) as FailVerdict;
	expect(v.reason).toBe("manifest-missing");
});

test("manifest 损坏（手改坏/半写）→ manifest-corrupt", () => {
	const f = fixture({ manifest: "{ broken json" });
	const v = checkKernelConsistency({
		manifestPath: f.manifestPath,
		exePath: f.exePath,
		appVersion: f.appVersion,
	}) as FailVerdict;
	expect(v.reason).toBe("manifest-corrupt");
});

test("清单 version ≠ 应用 version（壳新核旧事故形态）→ version-mismatch，带期望/实际值", () => {
	const f = fixture({ version: "0.10.1" }); // 清单是旧版内核
	const v = checkKernelConsistency({
		manifestPath: f.manifestPath,
		exePath: f.exePath,
		appVersion: "0.10.3", // 应用已升级
	}) as FailVerdict;
	expect(v.reason).toBe("version-mismatch");
	expect(v.expected.version).toBe("0.10.3");
	expect(v.actual.version).toBe("0.10.1");
});

test("exe 大小与清单不符（文件被锁未替换的典型残留形态）→ size-mismatch", () => {
	const f = fixture({ exeSize: 123, manifestSize: 1000 }); // 清单声称 1000，实际 123
	const v = checkKernelConsistency({
		manifestPath: f.manifestPath,
		exePath: f.exePath,
		appVersion: f.appVersion,
	}) as FailVerdict;
	expect(v.reason).toBe("size-mismatch");
	expect(v.expected.size).toBe(1000);
	expect(v.actual.size).toBe(123);
});

test("exe 缺失（安装中断/被杀软隔离）→ exe-missing", () => {
	const f = fixture({ exeMissing: true });
	const v = checkKernelConsistency({
		manifestPath: f.manifestPath,
		exePath: f.exePath,
		appVersion: f.appVersion,
	}) as FailVerdict;
	expect(v.reason).toBe("exe-missing");
});
