import { test, expect } from "bun:test";
import { AGENCY_DEPARTMENTS } from "../src/agency-presets";
import type { AgencyPreset, AgencyPresetMeta } from "../src/agency-presets";

test("AGENCY_DEPARTMENTS 覆盖 19 个部门目录", () => {
	expect(Object.keys(AGENCY_DEPARTMENTS)).toHaveLength(19);
	expect(AGENCY_DEPARTMENTS["engineering"]).toBe("工程部");
	expect(AGENCY_DEPARTMENTS["game-development"]).toBe("游戏开发部");
	expect(AGENCY_DEPARTMENTS["gis"]).toBe("GIS 部");
});

test("AgencyPresetMeta 不含 body（类型层面 Omit 的运行时佐证）", () => {
	const meta: AgencyPresetMeta = {
		id: "engineering-frontend-developer",
		name: "前端开发者",
		description: "精通 React",
		emoji: "💻",
		color: "#06B6D4",
		department: "工程部",
	};
	expect("body" in meta).toBe(false);
	// AgencyPreset 则有 body
	const full: AgencyPreset = { ...meta, body: "# 人格" };
	expect(full.body).toBe("# 人格");
});
