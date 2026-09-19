import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectItem, clampMenuPos } from "../src/components/ProjectItem";
import { useProjectUiStore } from "../src/store/project-ui";
import type { ProjectEntity, SessionEntity } from "@wa-pi/shared";

// ---- 测试数据 ----
const project: ProjectEntity = {
	id: "test-proj",
	name: "测试项目",
	cwd: "/tmp/test",
	createdAt: Date.now(),
};

const session: SessionEntity = {
	id: "s1",
	projectId: "test-proj",
	primaryAgent: "dev",
	title: "会话1",
	createdAt: Date.now(),
	lastActivity: Date.now(),
	piSessionFile: "/tmp/s1.jsonl",
};

// ---- 纯函数单元测试 ----
describe("clampMenuPos", () => {
	test("菜单在视口中央，坐标不变", () => {
		const result = clampMenuPos(400, 300, 140, 120, 1920, 1080);
		expect(result.left).toBe(400);
		expect(result.top).toBe(300);
	});

	test("菜单底部溢出时上移到视口内", () => {
		// y=1000, height=120, vh=1080 → 1000+120=1120 > 1072(1080-8)
		const result = clampMenuPos(400, 1000, 140, 120, 1920, 1080);
		expect(result.top).toBe(952); // 1080 - 120 - 8
		expect(result.left).toBe(400);
	});

	test("菜单右缘溢出时左移到视口内", () => {
		const result = clampMenuPos(1850, 300, 140, 120, 1920, 1080);
		expect(result.left).toBe(1772); // 1920 - 140 - 8
		expect(result.top).toBe(300);
	});

	test("菜单同时在底部和右缘溢出", () => {
		const result = clampMenuPos(1850, 1000, 140, 120, 1920, 1080);
		expect(result.left).toBe(1772);
		expect(result.top).toBe(952);
	});

	test("菜单比视口还高时，top 钳制到 margin", () => {
		const result = clampMenuPos(400, 0, 140, 2000, 1920, 1080);
		expect(result.top).toBe(8); // Math.max(8, 1080-2000-8) = 8
	});

	test("自定义 margin 生效", () => {
		const result = clampMenuPos(400, 1000, 140, 120, 1920, 1080, 20);
		expect(result.top).toBe(940); // 1080 - 120 - 20
	});

	test("坐标刚好不溢出时不变", () => {
		// y + height = 1072, vh - margin = 1072 → 恰好不溢出
		const result = clampMenuPos(400, 952, 140, 120, 1920, 1080);
		expect(result.top).toBe(952);
	});
});

// ---- 组件测试：菜单位置钳制 ----
describe("ProjectItem 右键菜单边界钳制", () => {
	// bun:test --isolate 下裸 Element/HTMLElement 不在全局作用域，需通过 globalThis 访问
	const El = globalThis.Element;
	let origGBCR: () => DOMRect;

	beforeEach(() => {
		// 重置展开状态
		useProjectUiStore.getState().setExpanded(project.id, true);
		origGBCR = El.prototype.getBoundingClientRect;
	});

	afterEach(() => {
		El.prototype.getBoundingClientRect = origGBCR;
	});

	test("右键靠近窗口底部时，项目菜单 top 被钳制到视口内", () => {
		// 模拟小窗口
		Object.defineProperty(window, "innerWidth", {
			value: 800,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(window, "innerHeight", {
			value: 400,
			writable: true,
			configurable: true,
		});

		// 全局 mock getBoundingClientRect：右键菜单返回固定尺寸，其他元素返回零
		El.prototype.getBoundingClientRect = function () {
			const testid = this.getAttribute?.("data-testid");
			if (
				testid === "project-context-menu" ||
				testid === "session-context-menu"
			) {
				return {
					width: 140,
					height: 120,
					top: 0,
					left: 0,
					bottom: 120,
					right: 140,
					x: 0,
					y: 0,
					toJSON: () => ({}),
				};
			}
			return {
				width: 0,
				height: 0,
				top: 0,
				left: 0,
				bottom: 0,
				right: 0,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			};
		};

		render(
			<ProjectItem
				project={project}
				sessions={[session]}
				currentSessionId={null}
				selected={true}
				onSelectSession={() => {}}
				onNewSessionInProject={() => {}}
				onSelectProject={() => {}}
			/>,
		);

		// 在底部位置右键 (y=390, 窗口高=400, 菜单高=120 → 390+120=510 > 392)
		const projectHeader = screen.getByTestId(`project-name-${project.id}`);
		fireEvent.contextMenu(projectHeader, {
			clientX: 100,
			clientY: 390,
			preventDefault: () => {},
		});

		const menu = screen.getByTestId("project-context-menu");
		// 初始 top=390，经过钳制应 ≤ 400-120-8=272
		const top = parseInt(menu.style.top, 10);
		expect(top).toBeLessThanOrEqual(272);
	});

	test("右键在窗口中部时，项目菜单坐标不变", () => {
		Object.defineProperty(window, "innerWidth", {
			value: 800,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(window, "innerHeight", {
			value: 800,
			writable: true,
			configurable: true,
		});

		El.prototype.getBoundingClientRect = function () {
			const testid = this.getAttribute?.("data-testid");
			if (testid === "project-context-menu") {
				return {
					width: 140,
					height: 120,
					top: 0,
					left: 0,
					bottom: 120,
					right: 140,
					x: 0,
					y: 0,
					toJSON: () => ({}),
				};
			}
			return {
				width: 0,
				height: 0,
				top: 0,
				left: 0,
				bottom: 0,
				right: 0,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			};
		};

		render(
			<ProjectItem
				project={project}
				sessions={[session]}
				currentSessionId={null}
				selected={true}
				onSelectSession={() => {}}
				onNewSessionInProject={() => {}}
				onSelectProject={() => {}}
			/>,
		);

		const projectHeader = screen.getByTestId(`project-name-${project.id}`);
		fireEvent.contextMenu(projectHeader, {
			clientX: 100,
			clientY: 200,
			preventDefault: () => {},
		});

		const menu = screen.getByTestId("project-context-menu");
		// y=200, height=120, vh=800 → 200+120=320 < 792, 不溢出，坐标不变
		expect(parseInt(menu.style.top, 10)).toBe(200);
	});

	test("右键靠近窗口底部时，会话菜单 top 也被钳制", () => {
		Object.defineProperty(window, "innerWidth", {
			value: 800,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(window, "innerHeight", {
			value: 400,
			writable: true,
			configurable: true,
		});

		El.prototype.getBoundingClientRect = function () {
			const testid = this.getAttribute?.("data-testid");
			if (testid === "session-context-menu") {
				return {
					width: 140,
					height: 120,
					top: 0,
					left: 0,
					bottom: 120,
					right: 140,
					x: 0,
					y: 0,
					toJSON: () => ({}),
				};
			}
			return {
				width: 0,
				height: 0,
				top: 0,
				left: 0,
				bottom: 0,
				right: 0,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			};
		};

		render(
			<ProjectItem
				project={project}
				sessions={[session]}
				currentSessionId={null}
				selected={true}
				onSelectSession={() => {}}
				onNewSessionInProject={() => {}}
				onSelectProject={() => {}}
			/>,
		);

		// 找到会话行并右键（SessionRow 用原生 addEventListener，fireEvent 派发原生事件可触发）
		const sessionButton = screen.getByTestId("session-s1");
		fireEvent.contextMenu(sessionButton, {
			clientX: 100,
			clientY: 390,
			preventDefault: () => {},
		});

		const menu = screen.getByTestId("session-context-menu");
		const top = parseInt(menu.style.top, 10);
		expect(top).toBeLessThanOrEqual(272);
	});
});
