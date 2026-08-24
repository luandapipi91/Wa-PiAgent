import { expect, test } from "bun:test";
import {
	platformFor,
	kernelZipEntries,
	buildKernelManifest,
	makeBuild,
} from "./publish-kernel";

test("platformFor: win/linux/darwin 映射", () => {
	expect(platformFor("win")).toBe("win32-x64");
	expect(platformFor("linux")).toBe("linux-x64");
	expect(platformFor("darwin")).toBe("darwin-x64");
});

test("makeBuild: YYYYMMDD-seq", () => {
	expect(makeBuild(new Date(2026, 7, 23), 1)).toBe("20260823-1");
	expect(makeBuild(new Date(2026, 7, 23), 2)).toBe("20260823-2");
});

test("kernelZipEntries: 只含 kernel 三件套（根目录平铺）", () => {
	const entries = kernelZipEntries("/tmp/kernel", "darwin");
	const names = entries.map((e) => e.name).sort();
	expect(names).toEqual(["WaPiKernel", "bun.lock", "package.json"]);
	// entries 里每个 src 指向 /tmp/kernel 下对应文件
	expect(entries.every((e) => e.src.startsWith("/tmp/kernel/"))).toBe(true);
});

test("buildKernelManifest: 含全部字段", () => {
	const json = buildKernelManifest({
		version: "0.2.19",
		build: "20260823-1",
		kernelVersion: "1.4.0",
		platform: "darwin-x64",
		fileName: "kernel-20260823-1.zip",
		sha256: "ab12",
		size: 123,
		changelog: "修复队列悬挂",
	});
	const obj = JSON.parse(json);
	expect(obj.build).toBe("20260823-1");
	expect(obj.platform).toBe("darwin-x64");
	expect(obj.url).toBe("kernel-20260823-1.zip");
	expect(obj.sha256).toBe("ab12");
	expect(obj.size).toBe(123);
	expect(obj.changelog).toBe("修复队列悬挂");
});
