// mcp-migrate.test.ts — adapter 旧格式迁移的曝光档归一化（pi 1.2.0 alias 合并，先红后绿）。
//
// 迁移产物直接落盘：旧档 codemode-deferred 若原样落盘，pi 1.2.0 虽然接受（alias），
// 但盘上数据与现行四档漂移——迁移落盘即归一化，盘上数据一步到位。
import { describe, expect, test } from "bun:test";
import { migrateServerEntry } from "../src/mcp-migrate";

describe("migrateServerEntry 曝光档归一化（pi 1.2.0 alias）", () => {
	test("旧档 exposure / toolExposure 归一化为 codemode", () => {
		const out = migrateServerEntry({
			command: "npx",
			exposure: "codemode-deferred",
			toolExposure: { t1: "direct", t2: "codemode-deferred" },
		});
		expect(out.exposure).toBe("codemode");
		expect(out.toolExposure).toEqual({ t1: "direct", t2: "codemode" });
	});

	test("现行四档与未知键不受影响", () => {
		const out = migrateServerEntry({
			command: "npx",
			exposure: "deferred",
			customField: "keep-me",
		});
		expect(out.exposure).toBe("deferred");
		expect(out.customField).toBe("keep-me");
	});
});
