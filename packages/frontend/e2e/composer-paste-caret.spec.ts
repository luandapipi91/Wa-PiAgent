// 富文本粘贴光标 + 撤销 E2E（第四层）：真实 Chromium 中验证
//   ① 在文本中间粘贴（text/html + text/plain）→ 光标停在粘贴内容之后（而非被全量重写推到末尾）
//   ② 粘贴 token 文本 → chip 化 + state 收到 token 原文
//   ③ 粘贴后 Ctrl+Z → 撤销粘贴（execCommand 原生插入保留 undo 栈）
// 回归 bug：粘贴曾走 setText 拼接 + 半受控 innerHTML 全量重写，光标被强推到输入框末尾。
// 粘贴事件用 ClipboardEvent + DataTransfer 派发（与 Ctrl+V 进入 handlePaste 的链路一致，
// 且绕开 headless 剪贴板权限）；插入与撤销均为真实浏览器行为（execCommand / 原生 undo）。
import { test, expect } from "@playwright/test";
import { saveProvider } from "./helpers";

test("富文本粘贴：光标停在插入内容之后，Ctrl+Z 可撤销", async ({ page }) => {
	test.setTimeout(60_000);
	// 预置假 provider：避免首次启动向导弹窗遮挡输入框
	await saveProvider({
		id: "e2e-paste-caret-provider",
		name: "E2E Paste",
		slug: "e2e-paste",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});

	await page.goto("/");
	const textbox = page.getByRole("textbox");
	await expect(textbox).toBeVisible({ timeout: 10_000 });

	// 基础文本 + 光标放中间（"hello |world"，offset 6）
	await textbox.fill("hello world");
	await textbox.evaluate((el) => {
		el.focus();
		const tn = el.firstChild!;
		const r = document.createRange();
		r.setStart(tn, 6);
		r.collapse(true);
		const s = window.getSelection()!;
		s.removeAllRanges();
		s.addRange(r);
	});

	// 在光标处派发粘贴（浏览器 Ctrl+V 被 preventDefault 后走同一条 handlePaste 链路）
	await textbox.evaluate((el) => {
		const dt = new DataTransfer();
		dt.setData("text/plain", "PASTED");
		dt.setData("text/html", '<span style="color:red">PASTED</span>');
		el.dispatchEvent(
			new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
				cancelable: true,
			}),
		);
	});

	// 文本：前段 + 粘贴内容 + 后段（源样式被净化）
	await expect(textbox).toHaveText("hello PASTEDworld");

	// 光标停在粘贴内容之后：光标前文本长度 = 6 + 6 = 12（而非全量重写推到末尾的 17）
	const caret = await textbox.evaluate((el) => {
		const s = window.getSelection()!;
		const r = document.createRange();
		r.setStart(el, 0);
		r.setEnd(s.focusNode!, s.focusOffset);
		return r.toString().length;
	});
	expect(caret).toBe(12);

	// Ctrl+Z 撤销粘贴：execCommand 原生插入保留 undo 栈
	await page.keyboard.press("Control+z");
	await expect(textbox).toHaveText("hello world");
});

test("粘贴 token 文本：chip 化且光标在 chip 之后", async ({ page }) => {
	test.setTimeout(60_000);
	await saveProvider({
		id: "e2e-paste-caret-provider",
		name: "E2E Paste",
		slug: "e2e-paste",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});

	await page.goto("/");
	const textbox = page.getByRole("textbox");
	await expect(textbox).toBeVisible({ timeout: 10_000 });

	await textbox.fill("");
	await textbox.evaluate((el) => el.focus());
	await textbox.evaluate((el) => {
		const dt = new DataTransfer();
		dt.setData("text/plain", "$[using-git-worktrees] 请开始");
		dt.setData("text/html", "$[using-git-worktrees] 请开始");
		el.dispatchEvent(
			new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
				cancelable: true,
			}),
		);
	});

	// token 渲染成 chip（data-token 保留完整 token）
	const chip = textbox.locator('[data-token="$[using-git-worktrees]"]');
	await expect(chip).toBeVisible();
	// state 同步为 token 原文（chip 经 extractText 还原，粘贴内容在末尾）
	await expect(textbox).toHaveText(/请开始$/);
	// 光标停在 chip 之后的文本节点（" 请开始"）末尾，而非落进 chip 内部或丢失
	const caretInfo = await textbox.evaluate(() => {
		const s = window.getSelection()!;
		const tn = s.focusNode;
		return {
			isTailText: tn?.nodeType === Node.TEXT_NODE && tn.textContent === " 请开始",
			offset: s.focusOffset,
		};
	});
	expect(caretInfo.isTailText).toBe(true);
	expect(caretInfo.offset).toBe(4);
});
