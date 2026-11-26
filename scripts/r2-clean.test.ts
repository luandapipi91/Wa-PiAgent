import { describe, it, expect } from "bun:test";
import {
	parseVersion,
	planCleanup,
	checkManifestConflicts,
	parseManifest,
	type R2ObjectLike,
} from "./r2-clean";

const obj = (key: string, size = 1): R2ObjectLike => ({ key, size });

describe("parseVersion", () => {
	it("从安装包 / blockmap key 解析版本号", () => {
		expect(parseVersion("releases/WaPi-Setup-0.10.15.exe")).toBe("0.10.15");
		expect(parseVersion("releases/WaPi-Setup-0.10.15.exe.blockmap")).toBe("0.10.15");
		expect(parseVersion("releases/WaPi-Setup-0.10.15.dmg.blockmap")).toBe("0.10.15");
		expect(parseVersion("releases/WaPi-Setup-0.10.15.zip")).toBe("0.10.15");
	});
	it("带构建 hash 后缀的重发包归入同一版本", () => {
		expect(parseVersion("releases/WaPi-Setup-0.7.15-3d632fea.zip")).toBe("0.7.15");
	});
	it("固定清单与无法识别的 key 返回 null", () => {
		expect(parseVersion("releases/latest.yml")).toBeNull();
		expect(parseVersion("releases/latest-mac.yml")).toBeNull();
		expect(parseVersion("releases/version-history.json")).toBeNull();
		expect(parseVersion("releases/README.txt")).toBeNull();
		expect(parseVersion("web/index.html")).toBeNull();
	});
});

describe("planCleanup", () => {
	// 四个版本各一个安装包 + blockmap，再加固定清单
	const objects: R2ObjectLike[] = [
		obj("releases/WaPi-Setup-0.10.15.exe", 100),
		obj("releases/WaPi-Setup-0.10.15.exe.blockmap", 1),
		obj("releases/WaPi-Setup-0.10.14.exe", 100),
		obj("releases/WaPi-Setup-0.10.14.exe.blockmap", 1),
		obj("releases/WaPi-Setup-0.10.13.exe", 100),
		obj("releases/WaPi-Setup-0.10.13.exe.blockmap", 1),
		obj("releases/WaPi-Setup-0.10.12.exe", 100),
		obj("releases/WaPi-Setup-0.10.12.exe.blockmap", 1),
		obj("releases/latest.yml", 1),
		obj("releases/latest-mac.yml", 1),
		obj("releases/version-history.json", 1),
	];

	it("保留最近 3 个版本的产物与固定清单，其余进入删除清单", () => {
		const plan = planCleanup(objects, 3);
		expect(plan.remove.map((o) => o.key)).toEqual([
			"releases/WaPi-Setup-0.10.12.exe",
			"releases/WaPi-Setup-0.10.12.exe.blockmap",
		]);
		expect(plan.keep.map((o) => o.key)).toContain("releases/WaPi-Setup-0.10.13.exe");
		expect(plan.keep.map((o) => o.key)).toContain("releases/latest.yml");
		expect(plan.keep.map((o) => o.key)).toContain("releases/latest-mac.yml");
		expect(plan.keep.map((o) => o.key)).toContain("releases/version-history.json");
		expect(plan.removeBytes).toBe(101);
	});

	it("keep=1 只保留最高版本", () => {
		const plan = planCleanup(objects, 1);
		expect(plan.keep.map((o) => o.key)).toEqual([
			"releases/WaPi-Setup-0.10.15.exe",
			"releases/WaPi-Setup-0.10.15.exe.blockmap",
			"releases/latest.yml",
			"releases/latest-mac.yml",
			"releases/version-history.json",
		]);
		expect(plan.remove).toHaveLength(6);
	});

	it("版本按数字比较而非字符串：0.10.x 高于 0.9.x", () => {
		const mixed: R2ObjectLike[] = [
			obj("releases/WaPi-Setup-0.9.5.exe"),
			obj("releases/WaPi-Setup-0.10.0.exe"),
			obj("releases/WaPi-Setup-0.10.9.exe"),
		];
		const plan = planCleanup(mixed, 2);
		expect(plan.remove.map((o) => o.key)).toEqual(["releases/WaPi-Setup-0.9.5.exe"]);
	});

	it("同版本的重发包（hash 后缀）与原包同进退", () => {
		const withHash: R2ObjectLike[] = [
			obj("releases/WaPi-Setup-0.7.15.zip"),
			obj("releases/WaPi-Setup-0.7.15-3d632fea.zip"),
			obj("releases/WaPi-Setup-0.7.16.zip"),
		];
		expect(planCleanup(withHash, 1).remove.map((o) => o.key)).toEqual([
			"releases/WaPi-Setup-0.7.15.zip",
			"releases/WaPi-Setup-0.7.15-3d632fea.zip",
		]);
	});

	it("无法识别的 key 不删除，归入 skipped 交人工判断", () => {
		const dirty: R2ObjectLike[] = [
			obj("releases/WaPi-Setup-0.10.15.exe"),
			obj("releases/README.txt"),
			obj("web/index.html"),
		];
		const plan = planCleanup(dirty, 1);
		expect(plan.remove).toEqual([]);
		expect(plan.skipped.map((o) => o.key)).toEqual(["releases/README.txt", "web/index.html"]);
	});
});

describe("parseManifest", () => {
	it("解析 latest.yml 的版本号与引用的文件名", () => {
		const yml = `version: 0.10.15
files:
  - url: WaPi-Setup-0.10.15.exe
    sha512: abc==
    size: 188156616
path: WaPi-Setup-0.10.15.exe
sha512: abc==
releaseDate: '2026-11-25T02:30:03.341Z'
releaseNotes: |-
  WA PI Agent 0.10.15 更新内容：
  【修复】
  - path: 不是文件的干扰行
`;
		const m = parseManifest(yml)!;
		expect(m.version).toBe("0.10.15");
		expect(m.files).toEqual(["WaPi-Setup-0.10.15.exe"]);
	});
	it("无法解析时返回 null", () => {
		expect(parseManifest("")).toBeNull();
		expect(parseManifest("<html>404</html>")).toBeNull();
	});
});

describe("checkManifestConflicts", () => {
	const objects: R2ObjectLike[] = [
		obj("releases/WaPi-Setup-0.10.15.exe"),
		obj("releases/WaPi-Setup-0.10.14.exe"),
		obj("releases/WaPi-Setup-0.10.13.exe"),
	];
	it("清单指向的版本在保留集合内 → 无冲突", () => {
		const plan = planCleanup(objects, 2);
		const m = { version: "0.10.15", files: ["WaPi-Setup-0.10.15.exe"] };
		expect(checkManifestConflicts(plan, [m])).toEqual([]);
	});
	it("清单指向的文件出现在删除清单 → 报冲突", () => {
		const plan = planCleanup(objects, 1);
		const stale = { version: "0.10.14", files: ["WaPi-Setup-0.10.14.exe"] };
		expect(checkManifestConflicts(plan, [stale])).toEqual([
			"清单 version=0.10.14 引用的 releases/WaPi-Setup-0.10.14.exe 在删除清单中",
		]);
	});
});
