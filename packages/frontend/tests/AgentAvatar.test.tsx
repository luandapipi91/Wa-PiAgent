// AgentAvatar：avatar 字段解析（icon: 前缀 / 旧 emoji 映射 / emoji 兼容）与卡通彩色图标渲染
import { test, expect, describe } from "bun:test";
import { render, screen } from "@testing-library/react";
import {
	resolveAgentAvatar,
	AgentAvatar,
	AgentAvatarContent,
} from "../src/components/ui/AgentAvatar";
import { AVATAR_ICONS, AVATAR_ICON_GROUPS } from "../src/components/ui/avatar-icons";

describe("resolveAgentAvatar", () => {
	test("icon: 前缀 → 彩色图标", () => {
		expect(resolveAgentAvatar("icon:rocket")).toEqual({
			type: "icon",
			icon: "rocket",
		});
	});

	test("旧 emoji 命中映射表 → 升级为卡通彩色图标（免迁移）", () => {
		expect(resolveAgentAvatar("🖥️")).toEqual({
			type: "icon",
			icon: "desktop-computer",
		});
		expect(resolveAgentAvatar("🏗️")).toEqual({
			type: "icon",
			icon: "hammer-and-wrench",
		});
		expect(resolveAgentAvatar("🔍")).toEqual({
			type: "icon",
			icon: "telescope",
		});
		expect(resolveAgentAvatar("🤖")).toEqual({ type: "icon", icon: "robot" });
	});

	test("其他 emoji → 走旧路径原样渲染", () => {
		expect(resolveAgentAvatar("🐉")).toEqual({ type: "emoji", emoji: "🐉" });
	});

	test("空值 → none（调用方兜底）", () => {
		expect(resolveAgentAvatar("")).toEqual({ type: "none" });
		expect(resolveAgentAvatar(undefined)).toEqual({ type: "none" });
	});

	test("icon: 未知名称 → none（不渲染不存在的图标）", () => {
		expect(resolveAgentAvatar("icon:no-such-icon")).toEqual({ type: "none" });
	});
});

describe("AgentAvatar 渲染", () => {
	test("icon 值渲染 <svg>，且背景用中性色而非传入渐变", () => {
		render(
			<AgentAvatar avatar="icon:rocket" background="#000-#111" testId="av" />,
		);
		const el = screen.getByTestId("av");
		expect(el.querySelector("svg")).toBeTruthy();
		// 彩色图标自带配色，渐变底会打架 → 中性底
		expect(el.getAttribute("style")).toContain("var(--surface)");
	});

	test("emoji 值渲染文本，保留传入渐变背景（旧数据兼容）", () => {
		const bg = "linear-gradient(135deg, #000, #111)";
		render(<AgentAvatar avatar="🐉" background={bg} testId="av" />);
		const el = screen.getByTestId("av");
		expect(el.textContent).toBe("🐉");
		expect(el.getAttribute("style")).toContain("linear-gradient");
	});

	test("空值渲染兜底：fallback 为 robot 占位自动升级彩色图标", () => {
		render(<AgentAvatar avatar="" fallback="🤖" testId="av" />);
		expect(screen.getByTestId("av").querySelector("svg")).toBeTruthy();
	});

	test("空值 fallback 为非映射 emoji 时原样文本", () => {
		render(<AgentAvatar avatar="" fallback="🐉" testId="av" />);
		expect(screen.getByTestId("av").textContent).toBe("🐉");
	});

	test("旧 emoji（映射命中）渲染 <svg>", () => {
		render(<AgentAvatar avatar="🎨" testId="av" />);
		expect(screen.getByTestId("av").querySelector("svg")).toBeTruthy();
	});
});

describe("AgentAvatarContent（纯内容，无背景盒）", () => {
	test("icon → 彩色 svg；emoji → 文本", () => {
		const { container: c1 } = render(
			<AgentAvatarContent avatar="icon:magnifying-glass-tilted-left" />,
		);
		expect(c1.querySelector("svg")).toBeTruthy();
		const { container: c2 } = render(<AgentAvatarContent avatar="🐉" />);
		expect(c2.querySelector("svg")).toBeNull();
		expect(c2.textContent).toBe("🐉");
	});
});

describe("审查修复：字号类与 emoji 变体归一化", () => {
	test("emoji 值应用 textClassName（字号类不被丢弃）", () => {
		render(<AgentAvatar avatar="🐉" textClassName="text-lg" testId="av" />);
		const inner = screen.getByTestId("av").querySelector("span.text-lg");
		expect(inner).toBeTruthy();
		expect(inner?.textContent).toBe("🐉");
	});

	test("无 VS16 的旧 emoji 变体（⚙）也命中映射", () => {
		expect(resolveAgentAvatar("⚙")).toEqual({ type: "icon", icon: "gear" });
	});
});

describe("回归锁：分组完整性", () => {
	test("所有图标都在选择面板分组内（无孤儿图标）", () => {
		const grouped = new Set<string>(AVATAR_ICON_GROUPS.flatMap((g) => g.icons));
		for (const name of Object.keys(AVATAR_ICONS)) {
			expect(grouped.has(name)).toBe(true);
		}
		expect(grouped.size).toBe(Object.keys(AVATAR_ICONS).length);
	});
});
