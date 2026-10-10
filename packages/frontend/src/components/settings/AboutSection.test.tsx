// 「关于」页 · 发现新版本退路分支测试：
// 版本历史数据缺失（pending 为空）时，releaseNotes 走 line-clamp-3 截断渲染——
// 回归锁定：截断态必须提供「查看全部」点击展开全文（旧实现死截断无展开手段，
// 版本历史数据迟到（内核 6h 缓存）时用户完全看不到新版本更新内容）。
import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AboutSection } from "./AboutSection";
import { useUpdaterStore } from "../../store/updater";
import { useVersionHistoryStore } from "../../store/version-history";

// 刻意不 mock api-client：mock.module 在 bun test 同进程批量跑时会污染其他测试文件。
// version-history.load() 对 api 拉取失败本就静默吞掉（保留现有 entries），
// happy-dom 下相对路径 fetch 必然失败 → beforeEach setState 的 entries 原样保持。

const LONG_NOTES = [
	"WA PI Agent 0.7.5 更新内容:",
	"",
	"【修复】",
	"",
	"- 修复删除会话时界面卡住数秒的问题（卡住的会话清理改为后台执行，UI 立即响应）",
	"- 修复浮动预览窗最小化后切到其他会话再切回时被意外展开的问题（保持最小化，点气泡可恢复）",
].join("\n");

beforeEach(() => {
	// pending 为空的前提：版本历史 entries 为空（线上数据迟到/内核缓存未过期的真实场景）
	useVersionHistoryStore.setState({ entries: [], loaded: true });
	useUpdaterStore.setState({
		status: "available",
		appVersion: "0.7.4",
		latestVersion: "0.7.5",
		releaseNotes: LONG_NOTES,
		isDesktop: true,
		error: null,
	});
});

test("退路截断态提供「查看全部」展开入口（数据缺失时不再死截断）", async () => {
	render(<AboutSection />);
	// 截断态：全文渲染在 DOM（line-clamp 视觉裁切）但带截断 class，且有展开入口
	const body = await screen.findByTestId("release-notes-body");
	expect(body.className).toContain("line-clamp-3");
	const toggle = screen.getByTestId("toggle-release-notes");
	expect(toggle.textContent).toContain("查看全部");
});

test("点击「查看全部」展开全文，再点「收起」恢复截断", async () => {
	render(<AboutSection />);
	const body = await screen.findByTestId("release-notes-body");
	const toggle = screen.getByTestId("toggle-release-notes");

	fireEvent.click(toggle);
	expect(body.className).not.toContain("line-clamp-3");
	expect(toggle.textContent).toContain("收起");

	fireEvent.click(toggle);
	expect(body.className).toContain("line-clamp-3");
	expect(toggle.textContent).toContain("查看全部");
});

test("pending 有数据时走区间摘要分支，不渲染退路截断块", async () => {
	useVersionHistoryStore.setState({
		entries: [
			{
				version: "0.7.5",
				date: "2026-10-10",
				sections: { 修复: ["修复删除会话卡顿"] },
			},
		],
		loaded: true,
	});
	render(<AboutSection />);
	// pending 分支接管：退路块不存在
	expect(
		screen.queryByTestId("release-notes-body"),
	).toBeNull();
	// 区间摘要出现
	expect(await screen.findByTestId("toggle-pending-versions")).toBeTruthy();
});
