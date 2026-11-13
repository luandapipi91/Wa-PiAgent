// KbCard 副本状态行（任务 11）：有 mirrorMeta 才渲染「副本 {converted} · 降级 {degraded}」，
// title 悬停展示 images 总数与转换器版本；无 mirrorMeta（旧库）整行不渲染。
// 注：简报示意代码用 vitest，本仓库未装 vitest，沿用 bun:test + @testing-library/react
// 约定（照 KbProgress.test，断言 toBeTruthy/toBeNull）；title 断言经审查 M-1 收紧为文案锚点（单字符 "1" 偏弱）。
import { describe, test, expect, beforeEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { KbCard } from "../KbCard";
import type { KbInfo } from "@wa-pi/shared";

// 最小挂载：KbCard 必填 onDelete/onToggleWatch，其余回调不传则不渲染对应按钮
const baseProps = { onDelete: () => {}, onToggleWatch: () => {} };

const base: KbInfo = {
	id: "kb_1",
	name: "产品知识库",
	description: "产品定价与规格",
	folderPath: "D:/资料/产品文档",
	status: "ready",
	fileCount: 1204,
	chunkCount: 18530,
	failedCount: 0,
	autoWatch: true,
	lastIndexedAt: Date.now(),
};

describe("KbCard 副本状态行", () => {
	beforeEach(() => {
		cleanup();
	});

	test("mirrorMeta 渲染副本统计", () => {
		render(
			<KbCard
				{...baseProps}
				kb={{ ...base, mirrorMeta: { converterVersion: 1, converted: 8, degraded: 1, images: 40 } }}
			/>,
		);
		expect(screen.getByText(/副本\s*8\s*·\s*降级\s*1/)).toBeTruthy();
		// title 悬停展示 images 总数与 converterVersion
		const line = screen.getByText(/副本\s*8\s*·\s*降级\s*1/);
		const title = line.getAttribute("title") ?? "";
		expect(title).toContain("图片 40 张"); // images 总数完整文案断言
		expect(title).toContain("版本 1"); // 版本文案锚点（单字符 "1" 可匹配任意含 1 子串，偏弱）
	});

	test("无 mirrorMeta(旧库) 不渲染副本行", () => {
		render(<KbCard {...baseProps} kb={{ ...base }} />);
		expect(screen.queryByText(/副本/)).toBeNull();
	});
});
