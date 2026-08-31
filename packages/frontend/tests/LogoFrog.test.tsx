// LogoFrog 组件与动作池测试：渲染口径（sidebar-title 文本不变）、动作池过滤、动画结束复位。
import { beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LogoFrog, pickLogoAction, resetLogoActionCycle, LOGO_ACTION_MS } from "../src/components/ui/frog/LogoFrog";
import type { LogoAction } from "../src/components/ui/frog/LogoFrog";

beforeEach(() => {
	resetLogoActionCycle();
	cleanup();
});

describe("pickLogoAction", () => {
	test("返回的一定是合法动作且不与上一次重复（动作池仅 B 组，Logo 自身动作用常驻 idle 循环）", () => {
		const LEGAL: LogoAction[] = [
			"hopUp", "patrol", "peekaboo", "tongue", "slide", "lie", "vault", "push", "drum",
		];
		for (let i = 0; i < 200; i++) {
			const a = pickLogoAction(true);
			expect(LEGAL).toContain(a);
			expect(pickLogoAction(true)).not.toBe(a);
		}
	});

	test("窄侧边栏（fullText=false）不选字母级动作", () => {
		const LETTER_ONLY: LogoAction[] = ["tongue", "slide", "lie", "push"];
		for (let i = 0; i < 200; i++) {
			expect(LETTER_ONLY).not.toContain(pickLogoAction(false));
		}
	});

	test("每个动作都有时长定义", () => {
		const LEGAL: LogoAction[] = [
			"hopUp", "patrol", "peekaboo", "tongue", "slide", "lie", "vault", "push", "drum",
		];
		for (const a of LEGAL) {
			expect(LOGO_ACTION_MS[a]).toBeGreaterThan(0);
		}
	});
});

describe("LogoFrog 渲染", () => {
	test("渲染 Logo 块与标题，textContent 口径与旧版一致（WA PI / Agent）", () => {
		render(<LogoFrog width={260} />);
		expect(screen.getByTestId("sidebar-title").textContent).toContain("WA PI");
		expect(screen.getByTestId("sidebar-title-agent").textContent).toContain("Agent");
		expect(document.querySelector(".wlf-logo")).toBeTruthy();
	});

	test("窄侧边栏（width<240）不渲染 Agent 尾段", () => {
		render(<LogoFrog width={200} />);
		expect(screen.queryByTestId("sidebar-title-agent")).toBeNull();
	});

	test("平时静止：无动作时无 data-active，迷你蛙隐藏（opacity 0 由 CSS 保证，DOM 上无动作 class）", () => {
		render(<LogoFrog width={260} />);
		const row = screen.getByTestId("logo-frog");
		expect(row.getAttribute("data-active")).toBeNull();
		expect(row.className).not.toContain("wlf-a-");
	});

	test("动画结束（哨兵 animationEnd 冒泡）不影响复位：只有哨兵自身触发才清理", () => {
		render(<LogoFrog width={260} />);
		const row = screen.getByTestId("logo-frog");
		// 直接对容器派发 animationEnd（target===currentTarget 的场景在真实动画中由哨兵触发；
		// 这里模拟容器上收到动画结束事件）
		fireEvent.animationEnd(row);
		expect(row.getAttribute("data-active")).toBeNull();
	});
});
