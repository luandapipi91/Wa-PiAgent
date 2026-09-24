import { test, expect } from "bun:test";
import { render } from "@testing-library/react";
import { Icon } from "./Icon";

test("新增图标可渲染：github / download / chevron-down / chevron-up", () => {
	for (const name of ["github", "download", "chevron-down", "chevron-up"] as const) {
		const { container } = render(<Icon name={name} size={13} />);
		const svg = container.querySelector("svg");
		expect(svg).toBeTruthy();
		expect(svg!.getAttribute("stroke")).toBe("currentColor");
		// 图形本身必须存在（未注册的图标名只会渲染出空 svg 外壳，故必须断言 path）
		expect(svg!.querySelector("path")).toBeTruthy();
	}
});
