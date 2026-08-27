// SidebarResizer × 冒泡隔离 组件测试：
// 运行时取证（2026-08-30）：地址栏宽度把手 mousedown 只有 preventDefault 没有 stopPropagation，
// 事件冒泡到 FloatWindow 根节点的「整窗拖动」处理器（其交互白名单不含 div）→ 两组
// window mousemove 循环并行消费同一 dx → 拖宽度时浮窗跟着平移。
// 契约：把手按下即归把手所有——祖先元素不得收到 mousedown（参照 FloatWindow 右下角
// resize 手柄已有的 stopPropagation 先例）。把手自身的宽度拖拽行为由
// browser-url-bar.test.tsx 守护，此处只锁冒泡隔离。
import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SidebarResizer } from "../SidebarResizer";

afterEach(() => cleanup());

test("把手 mousedown 不冒泡到祖先容器（浮窗不会跟着移动）", () => {
	const outerSpy = mock(() => {});
	render(
		<div onMouseDown={outerSpy} data-testid="outer">
			<SidebarResizer
				side="left"
				testId="handle"
				minWidth={160}
				getWidth={() => 300}
				onResize={() => {}}
			/>
		</div>,
	);
	fireEvent.mouseDown(screen.getByTestId("handle"), { clientX: 100 });
	expect(outerSpy).not.toHaveBeenCalled();
	// 收尾：结束把手内部挂到 window 的监听循环
	fireEvent.mouseUp(window);
});

test("把手悬停与拖拽期均使用水平双向箭头手势（ew-resize；mac 下 col-resize 字形非箭头）", () => {
	// inline 形态：Tailwind 类承载手势
	render(
		<SidebarResizer
			side="left"
			testId="handle-cursor"
			variant="inline"
			minWidth={160}
			getWidth={() => 300}
			onResize={() => {}}
		/>,
	);
	expect(screen.getByTestId("handle-cursor").className).toContain("ew-resize");
	fireEvent.mouseDown(screen.getByTestId("handle-cursor"), { clientX: 100 });
	expect(document.body.style.cursor).toBe("ew-resize");
	fireEvent.mouseUp(window);
	cleanup();

	// panel 形态（侧栏/分屏）：inline style 承载手势
	render(
		<SidebarResizer
			side="left"
			testId="handle-panel"
			minWidth={160}
			getWidth={() => 300}
			onResize={() => {}}
		/>,
	);
	const panelHandle = screen.getByTestId("handle-panel") as HTMLElement;
	expect(panelHandle.style.cursor).toBe("ew-resize");
	fireEvent.mouseDown(panelHandle, { clientX: 100 });
	expect(document.body.style.cursor).toBe("ew-resize");
	fireEvent.mouseUp(window);
});
