import { test, expect } from "bun:test";
import { render } from "@testing-library/react";
import { Icon } from "./Icon";

/**
 * 图标 path 契约：条数 + 每条 d 逐字相等。
 * 只断言「存在 path」无法发现图形被粘错（例如把 github 的 d 粘成 download 的 d），故逐字锁定。
 */
const PATH_CONTRACT = {
	github: [
		"M9 19c-5 1.5-5-2.5-7-3",
		"M16 22v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22",
	],
	download: ["M12 4v11", "M7.5 11l4.5 4.5L16.5 11", "M5 19h14"],
	// 复用的既有图标：期望值写死为既有几何 M6 9.5…（而非任务简报的 M6 9…），
	// 用回归护栏固化「复用既有 chevron-down、不动既有图标」这一决定，防止后来者顺手改成简报版。
	"chevron-down": ["M6 9.5l6 6 6-6"],
	"chevron-up": ["M6 15l6-6 6 6"],
} as const;

const NAMES = Object.keys(PATH_CONTRACT) as Array<keyof typeof PATH_CONTRACT>;

test("新增图标可渲染：github / download / chevron-down / chevron-up", () => {
	for (const name of NAMES) {
		const expected = PATH_CONTRACT[name];
		const { container } = render(<Icon name={name} size={13} />);
		const svg = container.querySelector("svg");
		expect(svg).toBeTruthy();
		expect(svg!.getAttribute("stroke")).toBe("currentColor");
		// 图形本身必须存在（未注册的图标名只会渲染出空 svg 外壳，故必须断言 path）
		const paths = [...svg!.querySelectorAll("path")];
		expect(paths.length).toBe(expected.length);
		expect(paths.map((p) => p.getAttribute("d"))).toEqual([...expected]);
	}
});
