// 归档区只读查看器渲染 E2E（第四层）：真实浏览器打开归档会话，验证聊天记录只渲染对话正文。
//
// 背景 bug：查看器把 role:"toolResult" 的消息当成助手正文——工具原始输出（ls 等）进气泡并走
// markdown 渲染，输出里的 "-" 独立行触发 setext 标题，整段变成 <h2> 大字，聊天记录面目全非。
// 修复后：非 user/assistant 的消息一律不渲染。
//
// 环境：global-setup 已起隔离 kernel（独立 WA_PI_DIR）。会话经 REST 创建后直接写 jsonl 造消息，
// 再经 DELETE /api/sessions/:id 软删（归档），最后在浏览器里打开回收站查看器断言。
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR, E2E_WS_PORT } from "../playwright.config";
import { createProject, createSessionViaPrompt, saveProvider } from "./helpers";

const BASE = `http://127.0.0.1:${E2E_WS_PORT}`;

async function api<T = any>(
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: body !== undefined ? { "content-type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const data: any = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`REST ${method} ${path} 失败(${res.status})`);
	return data as T;
}

// 工具输出：含 "-" 独立行（markdown setext 标题触发条件）
const LS_OUTPUT = [
	"total 7912",
	"drwxr-xr-x   43 co  staff    1376 Sep 23 10:20 .",
	"---",
	"-rw-------    1 co  staff    1297 Sep 18 17:13 auth.json",
].join("\n");

const SESSION_ID = "s-e2e-trash-view-" + randomUUID().slice(0, 8);
const USER_TEXT = "请把启动器里的应用移除";
const ASSISTANT_TEXT = "好的，先看一下当前目录";

test("归档查看器只渲染对话正文：工具输出不进气泡、不出现标题大字", async ({
	page,
}) => {
	test.setTimeout(60_000);

	const projectCwd = join(E2E_WA_PI_DIR, "trash-view-e2e-proj");
	mkdirSync(projectCwd, { recursive: true });
	const project = await createProject(
		`e2e-trash-view-${randomUUID().slice(0, 8)}`,
		projectCwd,
	);
	await saveProvider({
		id: "e2e-trash-view-provider",
		name: "E2E TrashView",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});
	await createSessionViaPrompt(project.id, {
		agentName: "dev",
		text: "归档查看器E2E",
		model: "E2E TrashView/model-a",
		sessionId: SESSION_ID,
	});

	// 直接写 jsonl：user / assistant 正文 / toolResult / 又一条 user
	writeFileSync(
		join(E2E_WA_PI_DIR, "sessions", `${SESSION_ID}.jsonl`),
		[
			JSON.stringify({ type: "session", version: 3, id: SESSION_ID }),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				message: {
					role: "user",
					content: [{ type: "text", text: USER_TEXT }],
					timestamp: 1,
				},
			}),
			JSON.stringify({
				type: "message",
				id: "m2",
				parentId: "m1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: ASSISTANT_TEXT }],
					timestamp: 2,
					model: "m",
					stopReason: "end_turn",
				},
			}),
			JSON.stringify({
				type: "message",
				id: "m3",
				parentId: "m2",
				message: {
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "bash",
					content: [{ type: "text", text: LS_OUTPUT }],
					isError: false,
					timestamp: 3,
				},
			}),
			JSON.stringify({
				type: "message",
				id: "m4",
				parentId: "m3",
				message: {
					role: "user",
					content: [{ type: "text", text: "继续" }],
					timestamp: 4,
				},
			}),
		].join("\n"),
	);

	// 归档（软删除）
	await api("DELETE", `/api/sessions/${SESSION_ID}`);

	try {
		await page.goto("/");
		await expect(page.getByTestId("new-session-pane")).toBeVisible({
			timeout: 10_000,
		});

		// 打开归档区 → 查看该会话
		await page.getByTestId("recycle-bin-btn").click();
		await page.getByTestId(`trash-view-${SESSION_ID}`).click();

		const viewer = page.getByTestId("modal-content");
		await expect(viewer.getByText("此会话在归档区中")).toBeVisible({
			timeout: 10_000,
		});

		// 对话正文可见
		await expect(viewer.getByText(USER_TEXT)).toBeVisible();
		await expect(viewer.getByText(ASSISTANT_TEXT)).toBeVisible();
		await expect(viewer.getByText("继续", { exact: true })).toBeVisible();

		// 工具原始输出不得出现
		await expect(viewer.getByText(/total 7912/)).toHaveCount(0);
		await expect(viewer.getByText(/auth\.json/)).toHaveCount(0);

		// 工具输出不得被 markdown 渲染成标题
		expect(await viewer.locator("h1, h2, h3").count()).toBe(0);
	} finally {
		await api("DELETE", "/api/trash/sessions", {
			sessionIds: [SESSION_ID],
		}).catch(() => {});
		await api("DELETE", `/api/projects/${project.id}`).catch(() => {});
	}
});
