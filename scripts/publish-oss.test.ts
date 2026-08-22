import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listArtifacts, injectReleaseNotes } from "./publish-oss";

describe("listArtifacts", () => {
	const dir = mkdtempSync(join(tmpdir(), "r2-artifacts-"));
	beforeEach(() => {
		// targets 匹配项（Win + macOS）
		writeFileSync(join(dir, "latest.yml"), "a");
		writeFileSync(join(dir, "latest-mac.yml"), "a");
		writeFileSync(join(dir, "WaPi-Setup-1.2.3.exe"), "a");
		writeFileSync(join(dir, "WaPi-Setup-1.2.3.exe.blockmap"), "a");
		writeFileSync(join(dir, "WaPi-Setup-1.2.3.dmg"), "a");
		writeFileSync(join(dir, "WaPi-Setup-1.2.3.dmg.blockmap"), "a");
		writeFileSync(join(dir, "WaPi-Setup-1.2.3.zip"), "a");
		writeFileSync(join(dir, "WaPi-Setup-1.2.3.zip.blockmap"), "a");
		// 应被排除：无关文件 + Linux 产物（当前不走自动更新）
		writeFileSync(join(dir, "README.txt"), "a");
		writeFileSync(join(dir, "latest-linux.yml"), "a");
		writeFileSync(join(dir, "WaPi-Setup-1.2.3.AppImage"), "a");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("只挑选 Win+macOS 更新产物并带 releases/ 前缀", () => {
		const out = listArtifacts(dir, "1.2.3");
		const keys = out.map((a) => a.key).sort();
		expect(keys).toEqual([
			"releases/WaPi-Setup-1.2.3.dmg",
			"releases/WaPi-Setup-1.2.3.dmg.blockmap",
			"releases/WaPi-Setup-1.2.3.exe",
			"releases/WaPi-Setup-1.2.3.exe.blockmap",
			"releases/WaPi-Setup-1.2.3.zip",
			"releases/WaPi-Setup-1.2.3.zip.blockmap",
			"releases/latest-mac.yml",
			"releases/latest.yml",
		]);
	});
});

describe("injectReleaseNotes", () => {
	it("history 文件不存在时原样返回 yml", () => {
		const yml = "version: 1.2.3\nfiles: []\n";
		expect(injectReleaseNotes(yml, join(tmpdir(), "no-such-history.json"))).toBe(
			yml,
		);
	});

	it("无 releaseNotes 时追加 YAML 字面量块", () => {
		const history = join(tmpdir(), "h1.json");
		writeFileSync(
			history,
			JSON.stringify([
				{
					version: "1.2.3",
					sections: { 新增: ["功能 A"], 修复: ["Bug B"] },
				},
			]),
		);
		const out = injectReleaseNotes("version: 1.2.3\nfiles: []\n", history);
		expect(out).toContain("releaseNotes: |-");
		expect(out).toContain("【新增】");
		expect(out).toContain("- 功能 A");
		expect(out).toContain("- Bug B");
	});

	it("已有 releaseNotes 时整体覆盖", () => {
		const history = join(tmpdir(), "h2.json");
		writeFileSync(
			history,
			JSON.stringify([{ version: "1.3.0", sections: { 修复: ["问题"] } }]),
		);
		const out = injectReleaseNotes(
			"version: 1.2.0\nreleaseNotes: |-\n  旧内容\nfiles: []\n",
			history,
		);
		expect(out).toContain("【修复】");
		expect(out).not.toContain("旧内容");
	});
});

// —— 上传顺序：安装包/blockmap 在前，latest*.yml 清单最后覆盖（防线上悬空）——
import { orderArtifactsForUpload } from "./publish-oss";

describe("orderArtifactsForUpload", () => {
	it("安装包/blockmap 排在清单之前", () => {
		const artifacts = [
			{ path: "/r/latest.yml", key: "releases/latest.yml" },
			{ path: "/r/a.exe", key: "releases/WaPi-Setup-0.2.17.exe" },
			{
				path: "/r/a.exe.blockmap",
				key: "releases/WaPi-Setup-0.2.17.exe.blockmap",
			},
			{ path: "/r/latest-mac.yml", key: "releases/latest-mac.yml" },
		];
		const ordered = orderArtifactsForUpload(artifacts);
		expect(ordered.map((a) => a.key)).toEqual([
			"releases/WaPi-Setup-0.2.17.exe",
			"releases/WaPi-Setup-0.2.17.exe.blockmap",
			"releases/latest.yml",
			"releases/latest-mac.yml",
		]);
	});
});
