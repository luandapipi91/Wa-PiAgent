/**
 * 对外文案「内置 MCP 迁移」事实一致性测试。
 *
 * 与 readme-tui-support.test.ts / website-tui-support.test.ts 同模式：只读文件、断言落点，
 * 把本轮（任务 14 第 1 轮修复）确认过的三个事实钉在自动化里，避免下次改同类文案只靠人眼：
 *   ① 配置路径：全局 `~/.pi/agent/mcp.json`、项目级 `<项目>/.pi/mcp.json`（README 两版与官网两版）
 *   ② 项目级配置的前置条件：先在应用内授权该项目，**并重启会话后**才生效
 *      （与 i18n `mcpForm.projectScopeHint` 同口径：pi 只在 session_start 读配置）
 *   ③ 旧实现 `pi-mcp-adapter` 在对外文案里不得残留
 * 另附发布说明（RELEASE_NOTES）三条口径断言：OAuth 在浏览器完成授权、暴露方式 5 档、稳定性修复并句。
 *
 * 先红后绿：本测试先于文案修复落盘，首跑必须为红。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const readmeEn = readFileSync(join(root, "README.md"), "utf8");
const readmeZh = readFileSync(join(root, "README.zh-CN.md"), "utf8");
const siteZh = readFileSync(join(root, "website/index.html"), "utf8");
const siteEn = readFileSync(join(root, "website/index.en.html"), "utf8");
const notes = readFileSync(join(root, "packages/desktop/RELEASE_NOTES.md"), "utf8");

const GLOBAL_PATH = "~/.pi/agent/mcp.json";

/** 归一化空白：官网英文段落按 ~90 列折行，短语可能被换行拆开 */
function flat(doc: string): string {
	return doc.replace(/\s+/g, " ");
}

describe("MCP 配置路径：全局 ~/.pi/agent/mcp.json + 项目级 <项目>/.pi/mcp.json", () => {
	test("官网两版都写明两条配置路径", () => {
		for (const [name, doc] of [
			["website/index.html", siteZh],
			["website/index.en.html", siteEn],
		] as const) {
			expect(doc, name).toContain(GLOBAL_PATH);
			expect(doc, name).toContain("/.pi/mcp.json");
		}
	});

	test("README 两版都写明两条配置路径", () => {
		expect(readmeEn).toContain(GLOBAL_PATH);
		expect(readmeEn).toContain("/.pi/mcp.json");
		expect(readmeZh).toContain(GLOBAL_PATH);
		expect(readmeZh).toContain("/.pi/mcp.json");
	});

	test("反向：不得残留迁移前的项目级路径 .mcp.json（无 .pi 前缀）", () => {
		for (const [name, doc] of [
			["README.md", readmeEn],
			["README.zh-CN.md", readmeZh],
			["website/index.html", siteZh],
			["website/index.en.html", siteEn],
		] as const) {
			expect(doc, name).not.toMatch(/(?<!\.pi)\/\.mcp\.json/);
		}
	});
});

describe("项目级配置的前置条件：授权 + 重启会话", () => {
	test("README 两版都写明需重启会话", () => {
		expect(flat(readmeEn)).toContain("restart the session");
		expect(flat(readmeZh)).toContain("重启会话");
	});

	test("官网两版都写明需重启会话", () => {
		expect(flat(siteZh)).toContain("重启会话");
		expect(flat(siteEn)).toContain("restart the session");
	});

	test("发布说明「注意」也写明项目级需重启会话生效", () => {
		expect(notes).toContain("需重启会话生效");
	});
});

describe("旧实现 pi-mcp-adapter 不得残留于对外文案", () => {
	test("README 两版与官网两版零命中", () => {
		for (const [name, doc] of [
			["README.md", readmeEn],
			["README.zh-CN.md", readmeZh],
			["website/index.html", siteZh],
			["website/index.en.html", siteEn],
		] as const) {
			expect(doc, name).not.toContain("pi-mcp-adapter");
		}
	});
});

describe("发布说明（RELEASE_NOTES）口径", () => {
	test("OAuth：登录授权在浏览器完成、但可在应用内发起", () => {
		expect(notes).toContain("可在应用内发起");
		expect(notes).toContain("浏览器");
		expect(notes).not.toMatch(/OAuth\s*登录与登出可在应用内完成/);
	});

	test("暴露方式列全 5 档且沿用 UI 标签", () => {
		for (const label of ["直接可用", "脚本调用", "脚本调用（按需加载）", "按需加载", "不暴露"]) {
			expect(notes).toContain(label);
		}
	});

	test("本分支自产自修的三条并成一句稳定性修复", () => {
		expect(notes).toContain("内置 MCP 实现的稳定性修复");
		expect(notes).not.toContain("无法保存");
		expect(notes).not.toContain("刷新竞态");
		expect(notes).not.toContain("用户消息");
	});
});
