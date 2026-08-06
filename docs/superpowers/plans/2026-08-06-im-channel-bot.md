# IM 渠道机器人功能（v1 企业微信）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把企业微信智能机器人的消息接入 WA PI Agent 的智能体，并将回复推回企微；支持多机器人、智能体绑定、工作区指令切换、渠道附加提示词、两档回复粒度。

**Architecture:** kernel 进程内置 `ChannelManager`：每个启用的渠道一条 `@wecom/aibot-node-sdk` WebSocket 长连接（`ChannelAdapter` 接口隔离），进站消息经会话映射（`channelId+chatId` → `projectId+sessionId`）喂给 `AgentManager.prompt()`，`agent_end` 后按回复粒度组装 markdown 经 `replyStream` 一次性回复。配置存 `~/.wa-pi/channels.json`，映射存 `~/.wa-pi/channel-sessions.json`；前端在设置页加「机器人」Section，侧边栏加「任务 | IM」页签。

**Tech Stack:** Bun + TypeScript（kernel，自研 HttpRouter + SSE）、React 19 + zustand + Tailwind（frontend）、`@wecom/aibot-node-sdk@^1.0.7`、bun:test（kernel 与 frontend 组件测试，happy-dom preload）、Playwright（E2E）。

**设计文档:** `docs/superpowers/specs/2026-08-06-im-channel-bot-design.md`（含已确认原型 `assets/2026-08-06-im-channel-bot/ui-preview-v3.html`）

**设计补充（规格未覆盖、实现前已与代码现状对齐的决定）：**

1. **渠道配置新增 `model` 字段**（`null` = 跟随智能体）。原因：`AgentManager.prompt()` 强制要求显式 `model`（agent-manager.ts:1172 无 model 直接 throw），而 `AgentConfig.model` 可为 `null`。解析链：渠道 `model` → 智能体 `model` → 报错回复。
2. **"默认智能体"的具体定义** = `configStore.listAgents()` 返回列表的第一项（与 `NewSessionPane.tsx:20-31` 的兜底规则一致：列表第一项）。智能体删除兜底即降级为此项。
3. **企微被动回复不支持纯 text**（官方协议仅 stream/markdown/template_card 等）→ 所有出站统一走 `replyStream(frame, reqId, markdown, finish=true)`，内容即 markdown。
4. **IM 侧无法获取用户昵称**（非超管创建时 userid 为加密串）→ 会话列表标题：单聊显示 userid，群聊显示 `群聊(<chatId 前8位>)`。
5. **v1 不实施渠道级固定工作目录绑定**（用户在澄清阶段选择"允许 IM 侧切换"）。
6. **`$` 技能引用在 kernel 侧内联展开**：SDK 的 `/skill:name` 展开只作用于用户消息文本，`--system-prompt` 路径不生效，因此 ChannelManager 在每次入站消息准备 `imChannelContext` 前自行把 `$[技能名]` 展开为 `<skill name location>SKILL.md 全文</skill>` XML 块（找不到的技能保留原文）。前端编辑框只做 `$` 触发自动补全（插入 `$[技能名]` token 文本），不做 chip 渲染（纯 textarea，保持简单）。

## Global Constraints

- 所有代码注释、commit message、测试标题使用中文；标识符保持英文语义清晰。
- 前端组件测试事实是 **bun:test + happy-dom preload**（`packages/frontend/bunfig.toml` → `tests/happydom-setup.ts`），**不是 Vitest**（AGENTS.md 此处已过时，以代码为准）。
- kernel store 函数必须接受 `file` 参数注入临时路径（可测性前提，仿 `settings-store.ts`）。
- API 输出中 `secret` 一律脱敏为 `****<尾4位>`；只在 PUT/POST 入参中接收明文。
- 路由逻辑薄、业务逻辑集中在 `ws-server.ts` 的 `handle()` switch case 中（现有模式）。
- 任何保存渠道的操作后调用 `agentManager.markAllDirty()`（提示词/模型/智能体变更需重建会话进程生效）。
- 遵循四层验收：单元 → 组件 → API（curl）→ E2E（Playwright），缺一不可；E2E 截图用后全删。
- 最小改动：不顺手重构无关代码；每行改动可追溯到本计划。

---

### Task 1: 共享类型 + 路径常量 + channel-store

**Files:**
- Modify: `packages/shared/src/types.ts`（在 `WSServerEvent` 联合附近追加；事件接口放对应联合声明之前）
- Modify: `packages/shared/src/constants.ts:26-32`（路径常量区追加）
- Create: `packages/kernel/src/channel-store.ts`
- Test: `packages/kernel/tests/channel-store.test.ts`

**Interfaces:**
- Produces（后续所有任务依赖）：
  - 类型 `ChannelType / ReplyGranularity / ChannelConfig / ChannelCredentials / ChannelStatus / ChannelStatusInfo / ChannelConversationInfo`
  - 事件接口 `ChannelsListRequest / ChannelsCreateRequest / ChannelsUpdateRequest / ChannelsDeleteRequest / ChannelAgentUsageRequest / ChannelConversationsListRequest / ChannelsCurrentResult / ChannelAgentUsageResult / ChannelConversationsResult / ChannelsChangedEvent / ChannelConversationsChangedEvent`（均加入对应 `WSClientEvent` / `WSServerEvent` 联合）
  - 常量 `CHANNELS_FILE / CHANNEL_SESSIONS_FILE / CHANNEL_TMP_DIR`
  - `ChannelSessionMapping`（kernel 侧映射实体）
  - 函数 `loadChannels(file?) / saveChannels(channels, file?) / validateChannelInput(input): string | null / loadChannelMappings(file?) / saveChannelMappings(mappings, file?) / maskSecret(secret): string`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/channel-store.test.ts`：

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadChannels,
	saveChannels,
	loadChannelMappings,
	saveChannelMappings,
	validateChannelInput,
	maskSecret,
	type ChannelSessionMapping,
} from "../src/channel-store";
import type { ChannelConfig } from "@wa-pi/shared";

let dir: string;
let channelsFile: string;
let mappingsFile: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wa-pi-channel-test-"));
	channelsFile = join(dir, "channels.json");
	mappingsFile = join(dir, "channel-sessions.json");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const sample: ChannelConfig = {
	id: "ch_1",
	type: "wecom",
	name: "客服机器人",
	enabled: true,
	credentials: { botId: "ww123", secret: "secret-abcd" },
	agentName: "前端开发者",
	model: null,
	extraSystemPrompt: "回复控制在200字内",
	replyGranularity: "standard",
	createdAt: 1786000000,
};

test("loadChannels：文件不存在 → 空数组", async () => {
	expect(await loadChannels(channelsFile)).toEqual([]);
});

test("saveChannels/loadChannels：往返一致且写盘", async () => {
	await saveChannels([sample], channelsFile);
	expect(await loadChannels(channelsFile)).toEqual([sample]);
	const onDisk = JSON.parse(await readFile(channelsFile, "utf8"));
	expect(onDisk.channels[0].credentials.botId).toBe("ww123");
});

test("loadChannels：文件损坏 → 空数组不抛错", async () => {
	await saveChannels([sample], channelsFile);
	await rm(channelsFile);
	const { writeFile } = await import("node:fs/promises");
	await writeFile(channelsFile, "{broken", "utf8");
	expect(await loadChannels(channelsFile)).toEqual([]);
});

test("validateChannelInput：缺 botId → 中文报错", () => {
	expect(validateChannelInput({ ...sample, credentials: { botId: "", secret: "x" } })).toContain("Bot ID");
});

test("validateChannelInput：非法 type/granularity → 报错；合法 → null", () => {
	expect(validateChannelInput({ ...sample, type: "msn" as any })).toContain("渠道类型");
	expect(validateChannelInput({ ...sample, replyGranularity: "verbose" as any })).toContain("回复粒度");
	expect(validateChannelInput(sample)).toBeNull();
});

test("maskSecret：保留尾4位", () => {
	expect(maskSecret("secret-abcd")).toBe("****abcd");
	expect(maskSecret("abc")).toBe("****");
});

test("mappings：保存/读取往返一致", async () => {
	const m: ChannelSessionMapping = {
		channelId: "ch_1",
		chatId: "wr_xxx",
		chatType: "group",
		currentProjectId: "__system__",
		sessions: { __system__: "sess_1" },
		lastMessagePreview: "你好",
		updatedAt: 1786000001,
	};
	await saveChannelMappings([m], mappingsFile);
	expect(await loadChannelMappings(mappingsFile)).toEqual([m]);
	expect(await loadChannelMappings(join(dir, "nonexistent.json"))).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/channel-store.test.ts`
Expected: FAIL（`../src/channel-store` 不存在）

- [ ] **Step 3: 实现类型、常量与 store**

`packages/shared/src/constants.ts` 路径常量区（:26-32 一带）追加：

```ts
export const CHANNELS_FILE = `${WA_PI_DIR}/channels.json`; // IM 渠道机器人配置
export const CHANNEL_SESSIONS_FILE = `${WA_PI_DIR}/channel-sessions.json`; // IM 会话→hiagent 会话映射
export const CHANNEL_TMP_DIR = `${WA_PI_DIR}/tmp/channels`; // 渠道图片等临时文件
```

`packages/shared/src/types.ts` 追加（位置：事件联合声明之前；并把接口名分别追加进 `WSClientEvent`、`WSServerEvent` 联合）：

```ts
/** IM 渠道类型：v1 仅 wecom 可用；mock 仅在 WA_PI_CHANNELS_MOCK=1 测试模式下注册 */
export type ChannelType = "wecom" | "wechat" | "feishu" | "qq" | "mock";
/** 机器人回复粒度：simple=仅正文；standard=正文+文件变更汇总 */
export type ReplyGranularity = "simple" | "standard";
export interface ChannelCredentials {
	botId: string;
	secret: string;
}
export interface ChannelConfig {
	id: string;
	type: ChannelType;
	name: string;
	enabled: boolean;
	credentials: ChannelCredentials;
	/** 关联智能体 displayName */
	agentName: string;
	/** "provider/modelId"；null = 跟随智能体 */
	model: string | null;
	/** 渠道附加系统提示词，注入位置在记忆段之前 */
	extraSystemPrompt: string;
	replyGranularity: ReplyGranularity;
	createdAt: number;
}
export type ChannelStatus = "connected" | "connecting" | "disconnected" | "error";
/** API 输出形态：secret 已脱敏，附实时连接状态 */
export interface ChannelStatusInfo extends Omit<ChannelConfig, "credentials"> {
	credentials: { botId: string; secret: string };
	status: ChannelStatus;
	statusDetail?: string;
}
/** 侧边栏 IM 页签的会话列表项 */
export interface ChannelConversationInfo {
	channelId: string;
	channelName: string;
	channelType: ChannelType;
	chatId: string;
	chatType: "single" | "group";
	sessionId: string;
	projectId: string;
	projectName: string;
	lastMessagePreview: string;
	updatedAt: number;
}
export interface ChannelsListRequest { type: "channels:list" }
export interface ChannelsCreateRequest { type: "channels:create"; channel: Omit<ChannelConfig, "id" | "createdAt"> }
export interface ChannelsUpdateRequest { type: "channels:update"; id: string; channel: Partial<Omit<ChannelConfig, "id" | "createdAt">> }
export interface ChannelsDeleteRequest { type: "channels:delete"; id: string }
export interface ChannelAgentUsageRequest { type: "channels:agent-usage"; agentName: string }
export interface ChannelConversationsListRequest { type: "channel-conversations:list" }
export interface ChannelsCurrentResult { type: "channels:current"; channels: ChannelStatusInfo[] }
export interface ChannelAgentUsageResult { type: "channels:agent-usage-result"; agentName: string; count: number; channelNames: string[] }
export interface ChannelConversationsResult { type: "channel-conversations:current"; conversations: ChannelConversationInfo[] }
/** 轻量变更标记：前端收到后重新拉取对应列表 */
export interface ChannelsChangedEvent { type: "channels:changed" }
export interface ChannelConversationsChangedEvent { type: "channel-conversations:changed" }
```

`packages/kernel/src/channel-store.ts`（模式严格仿 `settings-store.ts`：读失败回退、整体写、中文校验报错）：

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	CHANNELS_FILE,
	CHANNEL_SESSIONS_FILE,
	type ChannelConfig,
} from "@wa-pi/shared";

/** IM 会话映射：一个 IM 对话（channelId+chatId）在每个项目下对应一个稳定 hiagent 会话 */
export interface ChannelSessionMapping {
	channelId: string;
	chatId: string;
	chatType: "single" | "group";
	/** /use 指令切换；默认 __system__（默认工作区） */
	currentProjectId: string;
	/** projectId → sessionId */
	sessions: Record<string, string>;
	lastMessagePreview: string;
	updatedAt: number;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return fallback; // 文件不存在/损坏 → 回退，不抛错
	}
}

async function writeJson(file: string, data: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

export async function loadChannels(
	file: string = CHANNELS_FILE,
): Promise<ChannelConfig[]> {
	const raw = await readJson<{ channels?: ChannelConfig[] }>(file, {});
	return Array.isArray(raw.channels) ? raw.channels : [];
}

export async function saveChannels(
	channels: ChannelConfig[],
	file: string = CHANNELS_FILE,
): Promise<void> {
	await writeJson(file, { schemaVersion: 1, channels });
}

export async function loadChannelMappings(
	file: string = CHANNEL_SESSIONS_FILE,
): Promise<ChannelSessionMapping[]> {
	const raw = await readJson<{ mappings?: ChannelSessionMapping[] }>(file, {});
	return Array.isArray(raw.mappings) ? raw.mappings : [];
}

export async function saveChannelMappings(
	mappings: ChannelSessionMapping[],
	file: string = CHANNEL_SESSIONS_FILE,
): Promise<void> {
	await writeJson(file, { schemaVersion: 1, mappings });
}

const VALID_TYPES = new Set(["wecom", "wechat", "feishu", "qq", "mock"]);
const VALID_GRANULARITY = new Set(["simple", "standard"]);

/** 校验渠道入参；合法返回 null，非法返回中文错误（直接回前端展示） */
export function validateChannelInput(
	input: Omit<ChannelConfig, "id" | "createdAt">,
): string | null {
	if (!input.name?.trim()) return "机器人名称不能为空";
	if (!VALID_TYPES.has(input.type)) return `不支持的渠道类型: ${input.type}`;
	if (!input.credentials?.botId?.trim()) return "Bot ID 不能为空";
	if (!input.credentials?.secret?.trim()) return "Secret 不能为空";
	if (!VALID_GRANULARITY.has(input.replyGranularity))
		return `非法的回复粒度: ${input.replyGranularity}`;
	return null;
}

/** secret 脱敏：保留尾 4 位 */
export function maskSecret(secret: string): string {
	return secret.length > 4 ? `****${secret.slice(-4)}` : "****";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/channel-store.test.ts`
Expected: 8 个用例全 PASS

- [ ] **Step 5: 跑 shared/kernel 全量测试确认类型改动无回归**

Run: `cd packages/shared && bun test && cd ../kernel && bun test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/constants.ts packages/kernel/src/channel-store.ts packages/kernel/tests/channel-store.test.ts
git commit -m "feat(kernel): IM 渠道配置与会话映射存储层"
```

---

### Task 2: IM 指令解析（纯函数）

**Files:**
- Create: `packages/kernel/src/channels/commands.ts`
- Test: `packages/kernel/tests/channel-commands.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: `parseCommand(text, ctx): CommandResult`（Task 6 的 ChannelManager 消费）；`CommandContext { projects: {id,name}[], currentProjectId: string }`；`CommandResult { handled: boolean; reply?: string; switchProjectId?: string; resetSession?: boolean }`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/channel-commands.test.ts`：

```ts
import { expect, test } from "bun:test";
import { parseCommand } from "../src/channels/commands";

const ctx = {
	projects: [
		{ id: "__system__", name: "默认工作区" },
		{ id: "p1", name: "hiagent" },
	],
	currentProjectId: "__system__",
};

test("非指令文本 → handled=false", () => {
	expect(parseCommand("你好", ctx).handled).toBe(false);
	expect(parseCommand("/usego", ctx).handled).toBe(true); // 以 / 开头即按指令处理
});

test("/new → 重置会话", () => {
	const r = parseCommand("/new", ctx);
	expect(r.handled).toBe(true);
	expect(r.resetSession).toBe(true);
	expect(r.reply).toContain("新会话");
});

test("/projects → 列出工作区并标注当前", () => {
	const r = parseCommand("/projects", ctx);
	expect(r.reply).toContain("hiagent");
	expect(r.reply).toContain("默认工作区");
	expect(r.reply).toContain("当前");
});

test("/use 命中项目名 → switchProjectId", () => {
	const r = parseCommand("/use hiagent", ctx);
	expect(r.switchProjectId).toBe("p1");
	expect(r.reply).toContain("hiagent");
});

test("/use 未命中 → 报错并列出可用", () => {
	const r = parseCommand("/use 不存在的项目", ctx);
	expect(r.switchProjectId).toBeUndefined();
	expect(r.reply).toContain("未找到");
	expect(r.reply).toContain("hiagent");
});

test("/help 与未知指令 → 帮助文本", () => {
	expect(parseCommand("/help", ctx).reply).toContain("/new");
	expect(parseCommand("/xxx", ctx).reply).toContain("/new");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/channel-commands.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`packages/kernel/src/channels/commands.ts`：

```ts
/** IM 侧斜杠指令解析：命中即在 ChannelManager 层拦截，不进智能体 */

export interface CommandContext {
	projects: { id: string; name: string }[];
	currentProjectId: string;
}

export interface CommandResult {
	handled: boolean;
	reply?: string;
	switchProjectId?: string;
	resetSession?: boolean;
}

const HELP =
	"可用指令：\n/new 开始新会话\n/projects 列出可用工作区\n/use <工作区名> 切换工作区\n/help 查看帮助";

export function parseCommand(text: string, ctx: CommandContext): CommandResult {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return { handled: false };
	const [cmd, ...rest] = trimmed.split(/\s+/);
	const arg = rest.join(" ").trim();
	const projectList = ctx.projects
		.map((p) => `${p.id === ctx.currentProjectId ? "（当前）" : ""}${p.name}`)
		.join("\n");

	switch (cmd) {
		case "/new":
			return { handled: true, resetSession: true, reply: "已开始新会话。" };
		case "/projects":
			return { handled: true, reply: `可用工作区：\n${projectList}` };
		case "/use": {
			const hit = ctx.projects.find((p) => p.name === arg);
			if (!hit) {
				return {
					handled: true,
					reply: `未找到工作区「${arg}」。可用工作区：\n${projectList}`,
				};
			}
			return {
				handled: true,
				switchProjectId: hit.id,
				reply: `已切换到工作区：${hit.name}`,
			};
		}
		case "/help":
			return { handled: true, reply: HELP };
		default:
			return { handled: true, reply: `未知指令 ${cmd}。\n${HELP}` };
	}
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/channel-commands.test.ts`
Expected: 6 个用例全 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/channels/commands.ts packages/kernel/tests/channel-commands.test.ts
git commit -m "feat(kernel): IM 斜杠指令解析（/new /projects /use /help）"
```

---

### Task 3: 回复组装（粒度 + 字节切分，纯函数）

**Files:**
- Create: `packages/kernel/src/channels/reply-composer.ts`
- Test: `packages/kernel/tests/reply-composer.test.ts`

**Interfaces:**
- Consumes: `AgentMessage`（`@wa-pi/shared`，AssistantMessage.content 含 `TextContent | ThinkingContent | ToolCall`；`ToolCall.arguments.path` 为 edit/write 的文件路径）、`ReplyGranularity`（Task 1）
- Produces: `extractAssistantText(msgs): string`、`extractChangedFiles(msgs): string[]`、`composeReply(msgs, granularity): string`、`chunkByBytes(text, maxBytes?): string[]`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/reply-composer.test.ts`：

```ts
import { expect, test } from "bun:test";
import {
	composeReply,
	extractChangedFiles,
	extractAssistantText,
	chunkByBytes,
} from "../src/channels/reply-composer";

const userMsg = { role: "user", content: [{ type: "text", text: "问" }] };
const assistantWithTools = {
	role: "assistant",
	content: [
		{ type: "text", text: "已修复。" },
		{ type: "toolCall", id: "1", name: "edit", arguments: { path: "src/auth.ts" } },
		{ type: "toolCall", id: "2", name: "write", arguments: { path: "src/new.ts" } },
		{ type: "toolCall", id: "3", name: "bash", arguments: { command: "ls" } },
		{ type: "toolCall", id: "4", name: "edit", arguments: { path: "src/auth.ts" } }, // 重复路径去重
	],
};

test("extractAssistantText：拼接 text 块、跳过 thinking 与 toolCall", () => {
	const msgs: any[] = [
		userMsg,
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "..." },
				{ type: "text", text: "第一段" },
				{ type: "text", text: "第二段" },
			],
		},
	];
	expect(extractAssistantText(msgs)).toBe("第一段\n第二段");
});

test("extractChangedFiles：仅 edit/write，去重保序", () => {
	expect(extractChangedFiles([assistantWithTools as any])).toEqual([
		"src/auth.ts",
		"src/new.ts",
	]);
});

test("composeReply：simple 只回正文", () => {
	expect(composeReply([assistantWithTools as any], "simple")).toBe("已修复。");
});

test("composeReply：standard 附文件变更；无变更时不附", () => {
	expect(composeReply([assistantWithTools as any], "standard")).toBe(
		"已修复。\n\n📄 修改：src/auth.ts、src/new.ts",
	);
	const noEdit = { role: "assistant", content: [{ type: "text", text: "好的" }] };
	expect(composeReply([noEdit as any], "standard")).toBe("好的");
});

test("chunkByBytes：按 UTF-8 字节上限切分且不在多字节字符中间切断", () => {
	const text = "汉".repeat(100); // 每字 3 字节
	const chunks = chunkByBytes(text, 30);
	expect(chunks.length).toBe(10);
	for (const c of chunks) expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(30);
	expect(chunks.join("")).toBe(text);
	expect(chunkByBytes("短文本")).toEqual(["短文本"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/reply-composer.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`packages/kernel/src/channels/reply-composer.ts`：

```ts
import type { AgentMessage, ReplyGranularity } from "@wa-pi/shared";

/** 企微 stream/markdown 内容上限 20480 字节，留余量取 20000 */
export const REPLY_MAX_BYTES = 20_000;

/** 拼接本轮助手消息的全部 text 块（跳过 thinking/toolCall） */
export function extractAssistantText(turnMessages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const m of turnMessages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content as any[]) {
			if (block.type === "text" && typeof block.text === "string") {
				parts.push(block.text);
			}
		}
	}
	return parts.join("\n").trim();
}

/** 提取本轮 edit/write 工具调用的文件路径（去重、保序） */
export function extractChangedFiles(turnMessages: AgentMessage[]): string[] {
	const files: string[] = [];
	for (const m of turnMessages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content as any[]) {
			if (
				block.type === "toolCall" &&
				(block.name === "edit" || block.name === "write") &&
				typeof block.arguments?.path === "string" &&
				!files.includes(block.arguments.path)
			) {
				files.push(block.arguments.path);
			}
		}
	}
	return files;
}

/** 按回复粒度组装出站文本 */
export function composeReply(
	turnMessages: AgentMessage[],
	granularity: ReplyGranularity,
): string {
	const text = extractAssistantText(turnMessages);
	if (granularity === "simple") return text;
	const files = extractChangedFiles(turnMessages);
	return files.length > 0 ? `${text}\n\n📄 修改：${files.join("、")}` : text;
}

/** 按 UTF-8 字节上限切分；优先在换行处断开，绝不在多字节字符中间切断 */
export function chunkByBytes(
	text: string,
	maxBytes: number = REPLY_MAX_BYTES,
): string[] {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (Buffer.byteLength(rest, "utf8") > maxBytes) {
		// 按码点累积，保证不切断多字节字符
		let taken = "";
		let bytes = 0;
		for (const ch of rest) {
			const b = Buffer.byteLength(ch, "utf8");
			if (bytes + b > maxBytes) break;
			taken += ch;
			bytes += b;
		}
		// 优先在最后一个换行处断（至少保留 1/4 长度，避免碎块）
		const nl = taken.lastIndexOf("\n");
		if (nl > taken.length / 4) taken = taken.slice(0, nl);
		chunks.push(taken);
		rest = rest.slice(taken.length).replace(/^\n/, "");
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/reply-composer.test.ts`
Expected: 5 个用例全 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/channels/reply-composer.ts packages/kernel/tests/reply-composer.test.ts
git commit -m "feat(kernel): 渠道回复组装（简洁/标准粒度 + UTF-8 字节切分）"
```

---

### Task 4: ChannelAdapter 接口 + MockAdapter

**Files:**
- Create: `packages/kernel/src/channels/types.ts`
- Create: `packages/kernel/src/channels/mock-adapter.ts`
- Test: `packages/kernel/tests/mock-adapter.test.ts`

**Interfaces:**
- Consumes: `ChannelType / ChannelStatus / ChannelConfig`（Task 1）
- Produces（Task 6/8 依赖）：
  - `InboundMessage { chatId, chatType, fromUserId, msgId, text?, image?, unsupported?, replyFrame }`
  - `ChannelAdapter { readonly type; connect(); disconnect(); sendText(replyFrame, markdown); onMessage(cb); onStatus(cb); downloadImage?(image): Promise<Buffer> }`
  - `MockAdapter`：`inject(msg: Partial<InboundMessage>)` 模拟进站；`outbox: { replyFrame, text }[]` 记录出站；`status: ChannelStatus`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/mock-adapter.test.ts`：

```ts
import { expect, test } from "bun:test";
import { MockAdapter } from "../src/channels/mock-adapter";
import type { ChannelConfig } from "@wa-pi/shared";

const channel: ChannelConfig = {
	id: "ch_mock",
	type: "mock",
	name: "测试机器人",
	enabled: true,
	credentials: { botId: "b", secret: "s" },
	agentName: "前端开发者",
	model: null,
	extraSystemPrompt: "",
	replyGranularity: "standard",
	createdAt: 1,
};

test("MockAdapter：inject 触发 onMessage，sendText 记录 outbox", async () => {
	const a = new MockAdapter(channel);
	const received: any[] = [];
	a.onMessage((m) => received.push(m));
	const statuses: string[] = [];
	a.onStatus((s) => statuses.push(s));
	await a.connect();
	expect(statuses).toContain("connected");

	a.inject({ chatId: "u1", text: "你好" });
	expect(received).toHaveLength(1);
	expect(received[0].chatType).toBe("single"); // 缺省 single
	expect(received[0].msgId).toBeTruthy(); // 自动补 msgId
	expect(received[0].replyFrame).toBeTruthy();

	await a.sendText(received[0].replyFrame, "**回复**");
	expect(a.outbox).toHaveLength(1);
	expect(a.outbox[0].text).toBe("**回复**");

	await a.disconnect();
	expect(a.status).toBe("disconnected");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/mock-adapter.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`packages/kernel/src/channels/types.ts`：

```ts
import type { ChannelStatus, ChannelType } from "@wa-pi/shared";

/** 渠道无关的进站消息模型：各适配器把平台消息归一化成它 */
export interface InboundMessage {
	/** 会话标识：群聊=群 chatid，单聊=发送者 userid */
	chatId: string;
	chatType: "single" | "group";
	fromUserId: string;
	/** 平台消息唯一 id（排重用） */
	msgId: string;
	text?: string;
	image?: { url: string; aeskey?: string; name?: string };
	/** 不支持的消息类型说明（voice/file/video…），设置后 text/image 为空 */
	unsupported?: string;
	/** 平台原始帧，回复时必须透传（企微需携带 req_id）；适配器自定义形状 */
	replyFrame: unknown;
}

export interface ChannelImageRef {
	url: string;
	aeskey?: string;
}

/** 渠道适配器接口：飞书/QQ 等后续渠道各实现一个 */
export interface ChannelAdapter {
	readonly type: ChannelType;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	/** 发送 markdown 文本（被动回复；replyFrame 来自最近一条进站消息） */
	sendText(replyFrame: unknown, markdown: string): Promise<void>;
	onMessage(cb: (msg: InboundMessage) => void): void;
	onStatus(cb: (status: ChannelStatus, detail?: string) => void): void;
	/** 下载并解密图片（无图片能力的适配器可不实现） */
	downloadImage?(image: ChannelImageRef): Promise<Buffer>;
}
```

`packages/kernel/src/channels/mock-adapter.ts`：

```ts
import { randomUUID } from "node:crypto";
import type { ChannelConfig, ChannelStatus } from "@wa-pi/shared";
import type {
	ChannelAdapter,
	ChannelImageRef,
	InboundMessage,
} from "./types";

/** 内存假渠道：单元测试与 E2E（WA_PI_CHANNELS_MOCK=1）用，不进真实网络 */
export class MockAdapter implements ChannelAdapter {
	readonly type = "mock" as const;
	status: ChannelStatus = "disconnected";
	/** 出站记录：{ replyFrame, text } */
	outbox: { replyFrame: unknown; text: string }[] = [];
	/** 模拟下载图片时返回的内容 */
	imageStub: Buffer = Buffer.from("fake-image");
	private msgCb?: (msg: InboundMessage) => void;
	private statusCb?: (status: ChannelStatus, detail?: string) => void;

	constructor(private channel: ChannelConfig) {}

	async connect(): Promise<void> {
		this.setStatus("connected");
	}
	async disconnect(): Promise<void> {
		this.setStatus("disconnected");
	}
	async sendText(replyFrame: unknown, markdown: string): Promise<void> {
		this.outbox.push({ replyFrame, text: markdown });
	}
	async downloadImage(_image: ChannelImageRef): Promise<Buffer> {
		return this.imageStub;
	}
	onMessage(cb: (msg: InboundMessage) => void): void {
		this.msgCb = cb;
	}
	onStatus(cb: (status: ChannelStatus, detail?: string) => void): void {
		this.statusCb = cb;
	}

	/** 模拟一条进站消息（测试/E2E 注入用） */
	inject(msg: Partial<InboundMessage> & { chatId: string }): void {
		this.msgCb?.({
			chatType: "single",
			fromUserId: msg.chatId,
			msgId: randomUUID(),
			replyFrame: { mock: true, chatId: msg.chatId },
			...msg,
		} as InboundMessage);
	}

	private setStatus(s: ChannelStatus): void {
		this.status = s;
		this.statusCb?.(s);
	}
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/mock-adapter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/channels/types.ts packages/kernel/src/channels/mock-adapter.ts packages/kernel/tests/mock-adapter.test.ts
git commit -m "feat(kernel): ChannelAdapter 接口与 MockAdapter"
```

---

### Task 5: 提示词 im-channel 段注入

**Files:**
- Modify: `packages/kernel/src/system-prompt.ts:147-155`（段数组）、`:27-38`（SystemPromptContext）、`:164-186`（renderSegment）、`:208`（PROMPTS_SCHEMA_VERSION）
- Modify: `packages/kernel/src/agent-manager.ts:238-242`（ensureStarted 签名）、`:728-743`（composePrompt 调用点）、`_createSession`（参数透传）
- Test: `packages/kernel/tests/system-prompt-im-channel.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - 新段 id `"im-channel"`，位置固定在 `env-constraints` 之后、`memory-policy` 之前
  - `SystemPromptContext.imChannelContext?: string`（空/undefined → 段不出现）
  - `AgentManager.ensureStarted(projectId, agentName, sessionId, opts?: { imChannelContext?: string })`（Task 6 消费）

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/system-prompt-im-channel.test.ts`：

```ts
import { expect, test } from "bun:test";
import {
	composePrompt,
	DEFAULT_PROMPT_SEGMENTS,
	PROMPTS_SCHEMA_VERSION,
} from "../src/system-prompt";

// composePrompt 的 ctx 必填字段以 system-prompt.ts 的 SystemPromptContext 为准；
// 本测试只关心段序与 im-channel 段的显隐，其余动态段给空值即可
const baseCtx: any = {
	agentName: "前端开发者",
	builtinSkillsDir: "/tmp/skills",
	delegateRoster: "",
	memoryPolicy: "记忆策略",
	memorySnapshot: "",
	imChannelContext: undefined,
};

test("im-channel 段位于 env-constraints 之后、memory-policy 之前", () => {
	const ids = DEFAULT_PROMPT_SEGMENTS.map((s) => s.id);
	const env = ids.indexOf("env-constraints");
	const ch = ids.indexOf("im-channel");
	const mem = ids.indexOf("memory-policy");
	expect(ch).toBeGreaterThan(env);
	expect(ch).toBeLessThan(mem);
});

test("imChannelContext 为空 → 段不出现；有内容 → 出现在 memory-policy 之前", () => {
	const without = composePrompt(DEFAULT_PROMPT_SEGMENTS, baseCtx);
	expect(without).not.toContain("渠道专属规则");

	const withCtx = composePrompt(DEFAULT_PROMPT_SEGMENTS, {
		...baseCtx,
		imChannelContext: "渠道专属规则：回复控制在200字",
	});
	expect(withCtx).toContain("渠道专属规则：回复控制在200字");
	expect(withCtx.indexOf("渠道专属规则")).toBeLessThan(
		withCtx.indexOf("记忆策略"),
	);
});

test("PROMPTS_SCHEMA_VERSION 已升到 24", () => {
	expect(PROMPTS_SCHEMA_VERSION).toBe(24);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/system-prompt-im-channel.test.ts`
Expected: FAIL（无 `im-channel` 段 / 版本号 23）

- [ ] **Step 3: 实现**

`packages/kernel/src/system-prompt.ts` 三处修改 + 版本号：

```ts
// 1) SystemPromptContext（:27-38）加可选字段
export interface SystemPromptContext {
	// …既有字段不动…
	/** IM 渠道附加提示词：非渠道会话为 undefined/""，段自动消失 */
	imChannelContext?: string;
}

// 2) DEFAULT_PROMPT_SEGMENTS（:147-155）在 env-constraints 与 memory-policy 之间插入
{ id: "env-constraints" },
{ id: "im-channel" }, // 动态：IM 渠道附加提示词（仅渠道会话出现，固定在记忆段之前）
{ id: "memory-policy" },

// 3) renderSegment（:164-186）switch 加分支
case "im-channel":
	return ctx.imChannelContext ?? "";

// 4) PROMPTS_SCHEMA_VERSION（:208）23 → 24（ensurePromptsConfig 迁移会用 DEFAULT 数组重建，自动补齐新段）
export const PROMPTS_SCHEMA_VERSION = 24;
```

`packages/kernel/src/agent-manager.ts` 两处修改：

```ts
// 1) ensureStarted（:238-242）加第 4 个可选参数并透传
async ensureStarted(
	projectId: string,
	agentName: AgentName,
	sessionId: string,
	opts?: { imChannelContext?: string },
): Promise<SessionHandle> {
	// …既有缓存/重建逻辑不变，_createSession 调用处改为：
	// this._createSession(projectId, agentName, sessionId, opts?.imChannelContext)
}

// 2) _createSession 加形参 imChannelContext?: string，
//    composePrompt 调用点（:728-743）的 SystemPromptContext 实参加一行：
imChannelContext: imChannelContext ?? "",
```

注意：`ensureStarted` 缓存命中时不理会 opts（既有幂等语义）；渠道提示词变更后由调用方 `markAllDirty()` 触发下次重建生效（Task 7 的 update case 已含）。

- [ ] **Step 4: 跑新测试 + system-prompt 既有测试 + agent-manager 相关测试**

Run: `cd packages/kernel && bun test tests/system-prompt-im-channel.test.ts && bun test`
Expected: 新用例 PASS；全量无回归（若既有测试断言了段数组长度/版本号，按新段序同步修正）

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/system-prompt.ts packages/kernel/src/agent-manager.ts packages/kernel/tests/system-prompt-im-channel.test.ts
git commit -m "feat(kernel): 系统提示词新增 im-channel 段（记忆之前），ensureStarted 支持渠道上下文"
```

---

### Task 6: ChannelManager（消息编排核心）

**Files:**
- Create: `packages/kernel/src/channel-manager.ts`
- Test: `packages/kernel/tests/channel-manager.test.ts`

**Interfaces:**
- Consumes:
  - `loadChannels/saveChannels/loadChannelMappings/saveChannelMappings/validateChannelInput/maskSecret/ChannelSessionMapping`（Task 1）
  - `parseCommand`（Task 2）；`composeReply/chunkByBytes`（Task 3）；`ChannelAdapter/InboundMessage`（Task 4）
  - `ConfigStore.listAgents()/getAgent()`、`ProjectStore.load()/createSession()`、`AgentManager.ensureStarted/prompt/getMessages`
  - `SYSTEM_PROJECT_ID / SYSTEM_PROJECT_CWD / CHANNEL_TMP_DIR`（`@wa-pi/shared`）
- Produces（Task 7/8 依赖）：
  - `class ChannelManager`，构造 `new ChannelManager(deps: ChannelManagerDeps)`
  - `ChannelManagerDeps { configStore, projectStore, agentManager, broadcast(e), adapterFactories?, channelsFile?, mappingsFile?, tmpDir? }`
  - 方法：`start() / stop() / listWithStatus(): Promise<ChannelStatusInfo[]> / create(input): Promise<void> / update(id, patch): Promise<void> / remove(id): Promise<void> / agentUsage(agentName): {count, channelNames} / listConversations(): Promise<ChannelConversationInfo[]> / onSessionEvent(sessionId, event): void / mockInbound(channelId, chatId, text) / mockOutbox(channelId)`
  - `adapterFactories`： `Partial<Record<ChannelType, (channel: ChannelConfig) => ChannelAdapter>>`，缺省含 `mock`（仅 `WA_PI_CHANNELS_MOCK=1` 时）；`wecom` 由 Task 8 注册

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/channel-manager.test.ts`（AgentManager/Store 全部 stub；临时文件注入）：

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelManager } from "../src/channel-manager";
import { MockAdapter } from "../src/channels/mock-adapter";
import type { ChannelConfig } from "@wa-pi/shared";

let dir: string;
let manager: ChannelManager;
let adapter: MockAdapter;
let prompted: { sessionId: string; text: string; opts: any }[];
let ensured: any[];
let messagesBySession: Record<string, any[]>;
let sessionsCreated: any[];
let broadcasted: string[];

const channel: Omit<ChannelConfig, "id" | "createdAt"> = {
	type: "mock",
	name: "测试机器人",
	enabled: true,
	credentials: { botId: "b", secret: "s" },
	agentName: "前端开发者",
	model: "p/m",
	extraSystemPrompt: "渠道规则",
	replyGranularity: "standard",
};

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wa-pi-chmgr-test-"));
	prompted = [];
	ensured = [];
	messagesBySession = {};
	sessionsCreated = [];
	broadcasted = [];
	manager = new ChannelManager({
		channelsFile: join(dir, "channels.json"),
		mappingsFile: join(dir, "mappings.json"),
		tmpDir: join(dir, "tmp"),
		configStore: {
			listAgents: async () => [
				{ displayName: "前端开发者", model: null },
				{ displayName: "后端架构师", model: null },
			],
			getAgent: async (name: string) =>
				name === "前端开发者"
					? { displayName: "前端开发者", model: null, thinking: null }
					: null,
		} as any,
		projectStore: {
			load: async () => ({
				projects: [{ id: "__system__", name: "默认工作区", cwd: "/x", createdAt: 1 }],
				sessions: [],
			}),
			createSession: async (input: any) => {
				sessionsCreated.push(input);
				return { id: input.id, ...input };
			},
		} as any,
		agentManager: {
			ensureStarted: async (...a: any[]) => {
				ensured.push(a);
			},
			prompt: async (sessionId: string, text: string, opts: any) => {
				prompted.push({ sessionId, text, opts });
			},
			getMessages: (sid: string) => messagesBySession[sid] ?? [],
			isSessionBusy: () => false,
		} as any,
		broadcast: (e: any) => broadcasted.push(e.type),
		adapterFactories: {
			mock: (c) => {
				adapter = new MockAdapter(c);
				return adapter;
			},
		},
	});
});
afterEach(async () => {
	await manager.stop();
	await rm(dir, { recursive: true, force: true });
});

test("create：校验失败抛中文错；成功则落盘并连接", async () => {
	await expect(
		manager.create({ ...channel, credentials: { botId: "", secret: "s" } }),
	).rejects.toThrow("Bot ID");
	await manager.create(channel);
	const list = await manager.listWithStatus();
	expect(list).toHaveLength(1);
	expect(list[0].credentials.secret).toBe("****"); // 脱敏（"s" 长度<4 → ****）
	expect(list[0].status).toBe("connected");
});

test("进站文本：建映射、建会话、ensureStarted 携带渠道提示词、prompt 带模型", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "你好" });
	await new Promise((r) => setTimeout(r, 50));
	expect(sessionsCreated).toHaveLength(1);
	expect(sessionsCreated[0].projectId).toBe("__system__");
	expect(ensured[0][0]).toBe("__system__");
	expect(ensured[0][3]).toEqual({ imChannelContext: "渠道规则" });
	expect(prompted[0].opts.model).toBe("p/m"); // 渠道 model 优先
	expect(broadcasted).toContain("channel-conversations:changed");
});

test("指令拦截：/new 不进智能体，直接回复", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "/new" });
	await new Promise((r) => setTimeout(r, 50));
	expect(prompted).toHaveLength(0);
	expect(adapter!.outbox.at(-1)!.text).toContain("新会话");
});

test("/use 切换工作区后，下一条消息落到对应项目会话", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "/use 默认工作区" });
	await new Promise((r) => setTimeout(r, 50));
	expect(adapter!.outbox.at(-1)!.text).toContain("已切换");
});

test("agent_end：按粒度组装并经适配器回复；正文+文件变更", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "改个 bug" });
	await new Promise((r) => setTimeout(r, 50));
	const sid = prompted[0].sessionId;
	messagesBySession[sid] = [
		{ role: "user", content: [{ type: "text", text: "改个 bug" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "已修复。" },
				{ type: "toolCall", id: "1", name: "edit", arguments: { path: "a.ts" } },
			],
		},
	];
	manager.onSessionEvent(sid, { type: "agent_end" });
	await new Promise((r) => setTimeout(r, 50));
	expect(adapter!.outbox.at(-1)!.text).toBe("已修复。\n\n📄 修改：a.ts");
});

test("智能体删除兜底：降级为列表第一项并记 warning", async () => {
	await manager.create({ ...channel, agentName: "已删除的智能体" });
	adapter!.inject({ chatId: "u1", text: "在吗" });
	await new Promise((r) => setTimeout(r, 50));
	expect(ensured[0][1]).toBe("前端开发者"); // listAgents()[0]
	expect(prompted[0].opts.model).toBe("p/m"); // 渠道 model 仍优先
});

test("无可用模型 → 回复配置错误，不调 prompt", async () => {
	await manager.create({ ...channel, model: null });
	adapter!.inject({ chatId: "u1", text: "hi" });
	await new Promise((r) => setTimeout(r, 50));
	expect(prompted).toHaveLength(0);
	expect(adapter!.outbox.at(-1)!.text).toContain("模型");
});

test("不支持的消息类型 → 提示回复", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", unsupported: "voice" });
	await new Promise((r) => setTimeout(r, 50));
	expect(adapter!.outbox.at(-1)!.text).toContain("暂不支持");
});

test("agentUsage：统计引用某智能体的渠道", async () => {
	await manager.create(channel);
	const usage = await manager.agentUsage("前端开发者");
	expect(usage.count).toBe(1);
	expect(usage.channelNames).toEqual(["测试机器人"]);
	expect((await manager.agentUsage("没人用")).count).toBe(0);
});

test("listConversations：返回会话列表项（含预览与项目名）", async () => {
	await manager.create(channel);
	adapter!.inject({ chatId: "u1", text: "你好呀" });
	await new Promise((r) => setTimeout(r, 50));
	const convs = await manager.listConversations();
	expect(convs).toHaveLength(1);
	expect(convs[0].channelName).toBe("测试机器人");
	expect(convs[0].projectName).toBe("默认工作区");
	expect(convs[0].lastMessagePreview).toBe("你好呀");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/channel-manager.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`packages/kernel/src/channel-manager.ts`（关键点：映射键 `channelId:chatId`；`__system__` 会话先 mkdir 同名目录再 createSession；`agent_end` 后更新回复基线；每次入站实时解析智能体，删除兜底 `listAgents()[0]`）：

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	CHANNELS_FILE,
	CHANNEL_SESSIONS_FILE,
	CHANNEL_TMP_DIR,
	SYSTEM_PROJECT_CWD,
	SYSTEM_PROJECT_ID,
	type AgentConfig,
	type ChannelConfig,
	type ChannelConversationInfo,
	type ChannelStatus,
	type ChannelStatusInfo,
	type ChannelType,
	type WSServerEvent,
} from "@wa-pi/shared";
import {
	loadChannelMappings,
	loadChannels,
	maskSecret,
	saveChannelMappings,
	saveChannels,
	validateChannelInput,
	type ChannelSessionMapping,
} from "./channel-store";
import { parseCommand } from "./channels/commands";
import { chunkByBytes, composeReply } from "./channels/reply-composer";
import type { ChannelAdapter, InboundMessage } from "./channels/types";
import { MockAdapter } from "./channels/mock-adapter";
import type { AgentManager } from "./agent-manager";
import type { ConfigStore } from "./config-store";
import type { ProjectStore } from "./project-store";

type AdapterFactory = (channel: ChannelConfig) => ChannelAdapter;

export interface ChannelManagerDeps {
	configStore: ConfigStore;
	projectStore: ProjectStore;
	agentManager: AgentManager;
	broadcast: (e: WSServerEvent) => void;
	/** 测试注入；缺省仅注册 mock（且需 WA_PI_CHANNELS_MOCK=1）。wecom 在 index.ts 注册 */
	adapterFactories?: Partial<Record<ChannelType, AdapterFactory>>;
	channelsFile?: string;
	mappingsFile?: string;
	tmpDir?: string;
}

export class ChannelManager {
	private adapters = new Map<string, ChannelAdapter>();
	private statuses = new Map<string, { status: ChannelStatus; detail?: string }>();
	/** channelId:chatId → 最近一条进站帧（被动回复必须携带） */
	private lastFrames = new Map<string, unknown>();
	/** sessionId → 回复基线（getMessages 下标），agent_end 后更新，避免排队回合重复回复 */
	private replyBaseline = new Map<string, number>();
	/** sessionId → 映射键，onSessionEvent 反查用 */
	private sessionIndex = new Map<string, string>();
	private factories: Partial<Record<ChannelType, AdapterFactory>>;

	constructor(private deps: ChannelManagerDeps) {
		this.factories = deps.adapterFactories ?? {};
		if (!deps.adapterFactories && process.env.WA_PI_CHANNELS_MOCK === "1") {
			this.factories.mock = (c) => new MockAdapter(c);
		}
	}

	private get channelsFile() {
		return this.deps.channelsFile ?? CHANNELS_FILE;
	}
	private get mappingsFile() {
		return this.deps.mappingsFile ?? CHANNEL_SESSIONS_FILE;
	}
	private get tmpDir() {
		return this.deps.tmpDir ?? CHANNEL_TMP_DIR;
	}

	/** 启动全部 enabled 渠道（kernel 启动时调用） */
	async start(): Promise<void> {
		for (const ch of await loadChannels(this.channelsFile)) {
			if (ch.enabled) await this.connectChannel(ch);
		}
	}

	async stop(): Promise<void> {
		for (const a of this.adapters.values()) await a.disconnect().catch(() => {});
		this.adapters.clear();
	}

	async listWithStatus(): Promise<ChannelStatusInfo[]> {
		const channels = await loadChannels(this.channelsFile);
		return channels.map((c) => ({
			...c,
			credentials: { botId: c.credentials.botId, secret: maskSecret(c.credentials.secret) },
			status: this.statuses.get(c.id)?.status ?? (c.enabled ? "connecting" : "disconnected"),
			statusDetail: this.statuses.get(c.id)?.detail,
		}));
	}

	async create(input: Omit<ChannelConfig, "id" | "createdAt">): Promise<void> {
		const err = validateChannelInput(input);
		if (err) throw new Error(err);
		const channels = await loadChannels(this.channelsFile);
		if (channels.some((c) => c.credentials.botId === input.credentials.botId)) {
			throw new Error("Bot ID 已被其他机器人使用（同一 Bot ID 仅允许一条长连接）");
		}
		const channel: ChannelConfig = {
			...input,
			id: `ch_${randomUUID().slice(0, 8)}`,
			createdAt: Date.now(),
		};
		await saveChannels([...channels, channel], this.channelsFile);
		if (channel.enabled) await this.connectChannel(channel);
		this.deps.broadcast({ type: "channels:changed" });
	}

	async update(
		id: string,
		patch: Partial<Omit<ChannelConfig, "id" | "createdAt">>,
	): Promise<void> {
		const channels = await loadChannels(this.channelsFile);
		const idx = channels.findIndex((c) => c.id === id);
		if (idx < 0) throw new Error("机器人不存在");
		const next = { ...channels[idx], ...patch, id, createdAt: channels[idx].createdAt };
		// credentials 合并：secret 缺省（前端留空表示不修改）时保留原值
		if (patch.credentials && patch.credentials.secret === undefined) {
			next.credentials = {
				botId: patch.credentials.botId ?? channels[idx].credentials.botId,
				secret: channels[idx].credentials.secret,
			};
		}
		const err = validateChannelInput(next);
		if (err) throw new Error(err);
		if (
			channels.some(
				(c) => c.id !== id && c.credentials.botId === next.credentials.botId,
			)
		) {
			throw new Error("Bot ID 已被其他机器人使用（同一 Bot ID 仅允许一条长连接）");
		}
		channels[idx] = next;
		await saveChannels(channels, this.channelsFile);
		// 重建连接（先断后连，enabled 才连）
		await this.adapters.get(id)?.disconnect().catch(() => {});
		this.adapters.delete(id);
		if (next.enabled) await this.connectChannel(next);
		else this.statuses.set(id, { status: "disconnected" });
		// 提示词/模型/智能体变更需重建会话进程生效
		this.deps.agentManager.markAllDirty();
		this.deps.broadcast({ type: "channels:changed" });
	}

	async remove(id: string): Promise<void> {
		const channels = await loadChannels(this.channelsFile);
		await saveChannels(channels.filter((c) => c.id !== id), this.channelsFile);
		await this.adapters.get(id)?.disconnect().catch(() => {});
		this.adapters.delete(id);
		this.statuses.delete(id);
		this.deps.broadcast({ type: "channels:changed" });
	}

	/** 智能体被渠道引用的统计（删除智能体确认提示用） */
	async agentUsage(agentName: string): Promise<{ count: number; channelNames: string[] }> {
		const channels = await loadChannels(this.channelsFile);
		const used = channels.filter((c) => c.agentName === agentName).map((c) => c.name);
		return { count: used.length, channelNames: used };
	}

	async listConversations(): Promise<ChannelConversationInfo[]> {
		const [mappings, channels, { projects }] = await Promise.all([
			loadChannelMappings(this.mappingsFile),
			loadChannels(this.channelsFile),
			this.deps.projectStore.load(),
		]);
		const result: ChannelConversationInfo[] = [];
		for (const m of mappings) {
			const channel = channels.find((c) => c.id === m.channelId);
			if (!channel) continue; // 渠道已删：历史映射不在列表显示
			const sessionId = m.sessions[m.currentProjectId];
			if (!sessionId) continue;
			const project = projects.find((p) => p.id === m.currentProjectId);
			result.push({
				channelId: m.channelId,
				channelName: channel.name,
				channelType: channel.type,
				chatId: m.chatId,
				chatType: m.chatType,
				sessionId,
				projectId: m.currentProjectId,
				projectName: project?.name ?? m.currentProjectId,
				lastMessagePreview: m.lastMessagePreview,
				updatedAt: m.updatedAt,
			});
		}
		return result.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** 由 index.ts 的 AgentManager onEvent 挂钩（throttle 之前调用，agent_end 不可被节流丢弃） */
	onSessionEvent(sessionId: string, event: { type: string; [k: string]: any }): void {
		if (event.type !== "agent_end") return;
		const key = this.sessionIndex.get(sessionId);
		if (!key) return; // 非渠道会话
		void this.replyTurn(sessionId, key, event).catch((e) =>
			console.warn("[channel-manager] 回复失败:", e),
		);
	}

	/** mock 测试端点：注入进站消息 / 读取出站记录 */
	mockInbound(channelId: string, chatId: string, text: string): void {
		const a = this.adapters.get(channelId);
		if (a instanceof MockAdapter) a.inject({ chatId, text });
		else throw new Error("该渠道不是 mock 类型或未启用");
	}
	mockOutbox(channelId: string): { text: string }[] {
		const a = this.adapters.get(channelId);
		if (a instanceof MockAdapter) return a.outbox;
		return [];
	}

	// ---------- 内部 ----------

	private async connectChannel(channel: ChannelConfig): Promise<void> {
		const factory = this.factories[channel.type];
		if (!factory) {
			this.statuses.set(channel.id, { status: "error", detail: `渠道类型 ${channel.type} 暂未支持` });
			return;
		}
		const adapter = factory(channel);
		this.adapters.set(channel.id, adapter);
		this.statuses.set(channel.id, { status: "connecting" });
		adapter.onStatus((status, detail) => {
			this.statuses.set(channel.id, { status, detail });
			this.deps.broadcast({ type: "channels:changed" });
		});
		adapter.onMessage((msg) => {
			void this.handleInbound(channel, adapter, msg).catch((e) =>
				console.warn("[channel-manager] 进站处理失败:", e),
			);
		});
		await adapter.connect();
	}

	private async handleInbound(
		channel: ChannelConfig,
		adapter: ChannelAdapter,
		msg: InboundMessage,
	): Promise<void> {
		const key = `${channel.id}:${msg.chatId}`;
		this.lastFrames.set(key, msg.replyFrame);
		const reply = async (text: string) => {
			for (const chunk of chunkByBytes(text)) {
				await adapter.sendText(msg.replyFrame, chunk);
			}
		};

		if (msg.unsupported) {
			await reply(`暂不支持该消息类型（${msg.unsupported}），请发送文本或图片。`);
			return;
		}

		// 找/建映射
		const mappings = await loadChannelMappings(this.mappingsFile);
		let mapping = mappings.find((m) => m.channelId === channel.id && m.chatId === msg.chatId);
		if (!mapping) {
			mapping = {
				channelId: channel.id,
				chatId: msg.chatId,
				chatType: msg.chatType,
				currentProjectId: SYSTEM_PROJECT_ID,
				sessions: {},
				lastMessagePreview: "",
				updatedAt: Date.now(),
			};
			mappings.push(mapping);
		}
		const persist = () => saveChannelMappings(mappings, this.mappingsFile);

		// 指令拦截
		if (msg.text?.trim().startsWith("/")) {
			const { projects } = await this.deps.projectStore.load();
			const cmd = parseCommand(msg.text, {
				projects: projects.map((p) => ({ id: p.id, name: p.name })),
				currentProjectId: mapping.currentProjectId,
			});
			if (cmd.handled) {
				if (cmd.switchProjectId) {
					mapping.currentProjectId = cmd.switchProjectId;
					mapping.updatedAt = Date.now();
					await persist();
				}
				if (cmd.resetSession) {
					delete mapping.sessions[mapping.currentProjectId];
					await persist();
				}
				await reply(cmd.reply ?? "好的");
				return;
			}
		}

		// 智能体解析（每次入站实时解析：删除立即可感知，兜底列表第一项）
		const agent = await this.resolveAgent(channel);
		if (!agent) {
			await reply("机器人配置失效：系统内没有可用智能体，请在设置页检查。");
			return;
		}
		const model = channel.model ?? agent.model;
		if (!model) {
			await reply("机器人未配置可用模型：请在设置页为机器人或关联智能体指定模型。");
			return;
		}

		// 会话解析（同一项目下复用稳定会话）；启动/发送失败必须回复用户，不能静默
		try {
			const sessionId = await this.ensureSession(mapping, agent);
			this.sessionIndex.set(sessionId, key);
			await this.deps.agentManager.ensureStarted(
				mapping.currentProjectId,
				agent.displayName,
				sessionId,
				{ imChannelContext: channel.extraSystemPrompt || undefined },
			);

			// 图片附件
			const attachments: any[] = [];
			if (msg.image && adapter.downloadImage) {
				try {
					const buf = await adapter.downloadImage(msg.image);
					const dir = join(this.tmpDir, channel.id);
					await mkdir(dir, { recursive: true });
					const name = msg.image.name ?? `${msg.msgId}.png`;
					const path = join(dir, name);
					await writeFile(path, buf);
					attachments.push({ kind: "image", name, path, size: buf.length });
				} catch {
					await reply("图片处理失败，请重发或改发文字。");
					return;
				}
			}

			this.replyBaseline.set(sessionId, this.deps.agentManager.getMessages(sessionId).length);
			const text = msg.text?.trim() || (msg.image ? "请分析这张图片" : "");
			await this.deps.agentManager.prompt(sessionId, text, {
				model,
				thinking: agent.thinking ?? undefined,
				attachments: attachments.length ? attachments : undefined,
			});
		} catch (e) {
			await reply(`处理出错：${e instanceof Error ? e.message : String(e)}`);
			return;
		}

		mapping.lastMessagePreview = (msg.text ?? "[图片]").slice(0, 50);
		mapping.updatedAt = Date.now();
		await persist();
		this.deps.broadcast({ type: "channel-conversations:changed" });
	}

	/** 智能体解析：渠道指定 → 删除兜底 listAgents()[0]（与前端新建会话的默认规则一致） */
	private async resolveAgent(channel: ChannelConfig): Promise<AgentConfig | null> {
		const bound = await this.deps.configStore.getAgent(channel.agentName);
		if (bound) return bound;
		const agents = await this.deps.configStore.listAgents();
		if (channel.agentName && agents.length > 0) {
			console.warn(
				`[channel-manager] 渠道「${channel.name}」关联的智能体 ${channel.agentName} 已删除，降级为 ${agents[0].displayName}`,
			);
		}
		return agents[0] ?? null;
	}

	/** 会话解析：__system__ 需先 mkdir 与 createdAt 严格同名的目录（既有 ws-server 约定） */
	private async ensureSession(
		mapping: ChannelSessionMapping,
		agent: AgentConfig,
	): Promise<string> {
		const existing = mapping.sessions[mapping.currentProjectId];
		if (existing) return existing;
		const createdAt = Date.now();
		if (mapping.currentProjectId === SYSTEM_PROJECT_ID) {
			await mkdir(join(SYSTEM_PROJECT_CWD, String(createdAt)), { recursive: true });
		}
		const session = await this.deps.projectStore.createSession({
			projectId: mapping.currentProjectId,
			primaryAgent: agent.displayName,
			title: `IM · ${mapping.chatId.slice(0, 12)}`,
			id: `im-${mapping.channelId}-${mapping.currentProjectId}-${createdAt}`,
			createdAt,
		});
		mapping.sessions[mapping.currentProjectId] = session.id;
		return session.id;
	}

	/** agent_end → 按粒度组装回复（stopReason=error 或空正文 → 错误提示） */
	private async replyTurn(
		sessionId: string,
		key: string,
		event: { [k: string]: any },
	): Promise<void> {
		const sep = key.indexOf(":");
		const channelId = key.slice(0, sep);
		const adapter = this.adapters.get(channelId);
		const frame = this.lastFrames.get(key);
		if (!adapter || !frame) return;
		const messages = this.deps.agentManager.getMessages(sessionId);
		const baseline = this.replyBaseline.get(sessionId) ?? 0;
		const turn = messages.slice(baseline);
		this.replyBaseline.set(sessionId, messages.length);

		const channels = await loadChannels(this.channelsFile);
		const channel = channels.find((c) => c.id === channelId);
		if (!channel) return;

		let text: string;
		if (event.stopReason === "error") {
			text = `处理出错：${event.error ?? "未知错误"}`;
		} else {
			text = composeReply(turn, channel.replyGranularity);
			if (!text) text = "（本轮无文本回复）";
		}
		for (const chunk of chunkByBytes(text)) {
			await adapter.sendText(frame, chunk);
		}
	}
}
```

注意：本任务单测只注入 `mock` 工厂；`replyTurn` 中 `channels:changed`/`channel-conversations:changed` 两个事件类型来自 Task 1 的 `WSServerEvent` 联合。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/channel-manager.test.ts`
Expected: 10 个用例全 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/channel-manager.ts packages/kernel/tests/channel-manager.test.ts
git commit -m "feat(kernel): ChannelManager——渠道生命周期、会话映射、指令拦截、回复编排、智能体删除兜底"
```

---

### Task 6A: 渠道提示词 `$` 技能 token 展开（kernel）

**Files:**
- Create: `packages/kernel/src/channels/skill-expand.ts`
- Modify: `packages/kernel/src/channel-manager.ts`（deps 加 `skillManager`，`handleInbound` 的 ensureStarted 调用前展开）
- Modify: `packages/kernel/src/index.ts`（ChannelManager 实例化处传 `skillManager`，index.ts:84 附近已有 `SkillManager` 实例）
- Test: `packages/kernel/tests/skill-expand.test.ts`

**Interfaces:**
- Consumes: `SkillManager.scan()`（`skill-manager.ts:71`，返回含 `path` 的技能列表，`path` 为含 SKILL.md 的目录绝对路径）；`SkillInfo`（`packages/shared/src/skills.ts:14-19`）
- Produces: `expandSkillTokens(text: string, skills: { name: string; content: string }[]): string`（纯函数）；ChannelManager 入站链路中 `imChannelContext = expandSkillTokens(channel.extraSystemPrompt, …)`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/skill-expand.test.ts`：

```ts
import { expect, test } from "bun:test";
import { expandSkillTokens } from "../src/channels/skill-expand";

const skills = [
	{ name: "brainstorming", content: "# 头脑风暴\n先问清楚再动手。" },
	{ name: "tdd", content: "# TDD\n先写失败测试。" },
];

test("展开 $[name] 为 <skill> XML 块", () => {
	const out = expandSkillTokens("你是客服。$[brainstorming] 其余不变", skills);
	expect(out).toContain('<skill name="brainstorming"');
	expect(out).toContain("# 头脑风暴");
	expect(out).toContain("</skill>");
	expect(out).toContain("你是客服。");
	expect(out).toContain("其余不变");
});

test("多个 token 依次展开；未知技能保留原文", () => {
	const out = expandSkillTokens("$[tdd] 和 $[不存在的技能]", skills);
	expect(out).toContain('<skill name="tdd"');
	expect(out).toContain("# TDD");
	expect(out).toContain("$[不存在的技能]");
});

test("无 token → 原样返回；空串 → 空串", () => {
	expect(expandSkillTokens("没有引用", skills)).toBe("没有引用");
	expect(expandSkillTokens("", skills)).toBe("");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/skill-expand.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现纯函数 + ChannelManager 集成**

`packages/kernel/src/channels/skill-expand.ts`：

```ts
/** 技能 token 正则：与前端 quick-invoke 的 $[技能名] / ¥[技能名] 格式一致 */
const SKILL_TOKEN_RE = /[$¥]\[([^\]]+)\]/g;

/**
 * 把渠道附加提示词里的 $[技能名] 展开为 <skill> XML 块（仿 SDK _expandSkillCommand 的
 * 内联格式——SDK 的展开只作用于用户消息文本，--system-prompt 路径不生效，故 kernel 自行展开）。
 * 找不到的技能保留 $[name] 原文，不静默丢失。
 */
export function expandSkillTokens(
	text: string,
	skills: { name: string; content: string }[],
): string {
	if (!text || !text.includes("$")) return text;
	return text.replace(SKILL_TOKEN_RE, (raw, name: string) => {
		const skill = skills.find((s) => s.name === name);
		if (!skill) return raw;
		return `<skill name="${skill.name}">\n${skill.content}\n</skill>`;
	});
}
```

`packages/kernel/src/channel-manager.ts` 集成（三处小改）：

```ts
// 1) ChannelManagerDeps 加字段（SkillManager 类型来自 ./skill-manager）
skillManager?: { scan(): Promise<{ name: string; path: string }[]> }; // 结构子集，测试可 stub

// 2) 新增私有方法：读取全部技能的名称+内容（技能内容从 <path>/SKILL.md 读；读失败的跳过）
private async loadSkillContents(): Promise<{ name: string; content: string }[]> {
	if (!this.deps.skillManager) return [];
	const skills = await this.deps.skillManager.scan().catch(() => []);
	const result: { name: string; content: string }[] = [];
	for (const s of skills as any[]) {
		try {
			result.push({ name: s.name, content: await readFile(join(s.path, "SKILL.md"), "utf8") });
		} catch { /* 单个技能读取失败不阻塞 */ }
	}
	return result;
}

// 3) handleInbound 的 ensureStarted 调用处，extraSystemPrompt 先展开再传入：
const skills = channel.extraSystemPrompt.includes("$") ? await this.loadSkillContents() : [];
// …
{ imChannelContext: channel.extraSystemPrompt ? expandSkillTokens(channel.extraSystemPrompt, skills) : undefined },
```

`packages/kernel/src/index.ts`：ChannelManager 实例化处加 `skillManager`（复用 :84 附近已有的 `SkillManager` 实例；若 `scan()` 实际签名/返回形状不同，以 `skill-manager.ts` 为准适配上面的结构子集）。

注意：`SkillManager.scan()` 的真实返回形状若不是 `{name, path}[]` 直连（比如包了一层 `{skills}`），实现时以 `skill-manager.ts:71` 为准调整 `loadSkillContents` 的取值路径，并在 Task 6 的 channel-manager 测试 stub 里补 `skillManager: { scan: async () => [] }`。

- [ ] **Step 4: 跑测试确认通过 + ChannelManager 既有测试回归**

Run: `cd packages/kernel && bun test tests/skill-expand.test.ts tests/channel-manager.test.ts && bun test`
Expected: PASS（若 channel-manager 测试因 deps 新字段报错，补 stub 即可）

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/channels/skill-expand.ts packages/kernel/src/channel-manager.ts packages/kernel/src/index.ts packages/kernel/tests/skill-expand.test.ts
git commit -m "feat(kernel): 渠道提示词 $[技能] token 内联展开"
```

---

### Task 7: REST 路由 + ws-server 业务 case + 智能体引用计数

**Files:**
- Create: `packages/kernel/src/routes/channels.ts`
- Modify: `packages/kernel/src/ws-server.ts`（`:452-468` registerRoutes、`handle()` switch 加 case、`WSServerOpts` 加 `channelManager` 字段）
- Test: `packages/kernel/tests/routes-channels.test.ts`

**Interfaces:**
- Consumes: `ChannelManager` 全部公开方法（Task 6）；`RouteRegistrar/CallApiFn`（`routes/types.ts`）；事件类型（Task 1）
- Produces（前端 Task 9/10 依赖的 HTTP 契约）：
  - `GET /api/channels` → `ChannelsCurrentResult`
  - `POST /api/channels` body `{channel}` → `ChannelsCurrentResult`（全量刷新）
  - `PUT /api/channels/:id` body `{channel}` → `ChannelsCurrentResult`；`DELETE /api/channels/:id` → `ChannelsCurrentResult`
  - `GET /api/channels/agent-usage/:agentName` → `ChannelAgentUsageResult`
  - `GET /api/channel-conversations` → `ChannelConversationsResult`
  - mock 模式（`WA_PI_CHANNELS_MOCK=1`）：`POST /api/channels/:id/mock-inbound {chatId,text}`、`GET /api/channels/:id/mock-outbox`

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/routes-channels.test.ts`（仿 `routes-chat.test.ts` + `tests/helpers/http-api-kit.ts` 的 `withServer` 模式；ChannelManager 用 stub）：

```ts
import { expect, test } from "bun:test";
import { withServer } from "./helpers/http-api-kit"; // 若无 channels 版本，按 chat 模式内联一个
import { registerChannelRoutes } from "../src/routes/channels";

// 说明：http-api-kit 的 withServer 复刻 ws-server.handle() 的对应 case。
// 本测试按同模式建 channels 版本：callApi 分派到 stub ChannelManager。
const stubManager = {
	list: [] as any[],
	async listWithStatus() {
		return this.list;
	},
	async create(input: any) {
		if (!input.credentials?.botId) throw new Error("Bot ID 不能为空");
		this.list.push({ ...input, id: "ch_x", status: "connected", credentials: { botId: input.credentials.botId, secret: "****" } });
	},
	async update(id: string, patch: any) {
		if (!this.list.find((c: any) => c.id === id)) throw new Error("机器人不存在");
	},
	async remove(id: string) {
		this.list = this.list.filter((c: any) => c.id !== id);
	},
	async agentUsage(agentName: string) {
		return { count: agentName === "前端开发者" ? 1 : 0, channelNames: ["测试机器人"] };
	},
	async listConversations() {
		return [];
	},
	mockInbound() {},
	mockOutbox() {
		return [{ text: "回复" }];
	},
};

// withServer 的签名以 tests/helpers/http-api-kit.ts 实际导出为准；
// 若不支持自定义 registrar/callApi，则按该文件模式在本文件内联一个 channels 版 withServer
test("GET /api/channels 返回脱敏列表", async () => {
	stubManager.list = [
		{ id: "ch_x", name: "测试机器人", credentials: { botId: "b", secret: "****" }, status: "connected" },
	];
	await withChannelsServer(stubManager, async (base) => {
		const res = await fetch(`${base}/api/channels`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(body.channels[0].credentials.secret).toBe("****");
	});
});

test("POST /api/channels 缺 botId → 400 中文错误", async () => {
	await withChannelsServer(stubManager, async (base) => {
		const res = await fetch(`${base}/api/channels`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ channel: { name: "x", credentials: { botId: "", secret: "s" } } }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as any).error).toContain("Bot ID");
	});
});

test("GET /api/channels/agent-usage/:name 返回引用计数（中文名需 URL 编码）", async () => {
	await withChannelsServer(stubManager, async (base) => {
		const res = await fetch(
			`${base}/api/channels/agent-usage/${encodeURIComponent("前端开发者")}`,
		);
		const body = (await res.json()) as any;
		expect(body.count).toBe(1);
	});
});
```

（`withChannelsServer` 为按 `http-api-kit.ts` 模式写的本地辅助：起真实 `HttpRouter` + `registerChannelRoutes`，`callApi` 内联复刻 `ws-server.handle()` 的 channels case 分派到 stubManager，与生产逐字对齐。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/routes-channels.test.ts`
Expected: FAIL（路由未注册 → 404）

- [ ] **Step 3: 实现路由与 ws-server case**

`packages/kernel/src/routes/channels.ts`：

```ts
import type { RouteRegistrar } from "./types";
import { readJsonBody } from "./types";

export const registerChannelRoutes: RouteRegistrar = (r, callApi) => {
	r.add("GET", "/api/channels", async () => callApi({ type: "channels:list" }));
	r.add("POST", "/api/channels", async (req) => {
		const b = await readJsonBody(req);
		return callApi({ type: "channels:create", channel: b.channel });
	});
	r.add("PUT", "/api/channels/:id", async (req, p) => {
		const b = await readJsonBody(req);
		return callApi({ type: "channels:update", id: p.id, channel: b.channel });
	});
	r.add("DELETE", "/api/channels/:id", async (_req, p) =>
		callApi({ type: "channels:delete", id: p.id }),
	);
	r.add("GET", "/api/channels/agent-usage/:agentName", async (_req, p) =>
		callApi({ type: "channels:agent-usage", agentName: p.agentName }),
	);
	r.add("GET", "/api/channel-conversations", async () =>
		callApi({ type: "channel-conversations:list" }),
	);

	// mock 测试端点：仅 WA_PI_CHANNELS_MOCK=1 注册（E2E 用，生产不暴露）
	if (process.env.WA_PI_CHANNELS_MOCK === "1") {
		r.add("POST", "/api/channels/:id/mock-inbound", async (req, p) => {
			const b = await readJsonBody(req);
			return callApi({
				type: "channels:mock-inbound",
				id: p.id,
				chatId: b.chatId,
				text: b.text,
			} as any);
		});
		r.add("GET", "/api/channels/:id/mock-outbox", async (_req, p) =>
			callApi({ type: "channels:mock-outbox", id: p.id } as any),
		);
	}
};
```

`packages/kernel/src/ws-server.ts`：

```ts
// 1) WSServerOpts 加字段（与 agentManager 同模式，允许 null 占位回填）
channelManager: import("./channel-manager").ChannelManager | null;

// 2) registerRoutes()（:452-468）加一行
registerChannelRoutes(this.router, callApi, ctx);

// 3) handle() switch 加 case（放在 settings case 附近）：
case "channels:list": {
	const channels = this.opts.channelManager
		? await this.opts.channelManager.listWithStatus()
		: [];
	reply({ type: "channels:current", channels });
	break;
}
case "channels:create":
case "channels:update":
case "channels:delete": {
	try {
		const cm = this.opts.channelManager!;
		if (event.type === "channels:create") await cm.create(event.channel);
		else if (event.type === "channels:update") await cm.update(event.id, event.channel);
		else await cm.remove(event.id);
		reply({ type: "channels:current", channels: await cm.listWithStatus() });
	} catch (err) {
		reply({ type: "error", message: (err as Error).message });
	}
	break;
}
case "channels:agent-usage": {
	const usage = await this.opts.channelManager!.agentUsage(event.agentName);
	reply({ type: "channels:agent-usage-result", agentName: event.agentName, ...usage });
	break;
}
case "channel-conversations:list": {
	const conversations = this.opts.channelManager
		? await this.opts.channelManager.listConversations()
		: [];
	reply({ type: "channel-conversations:current", conversations });
	break;
}
case "channels:mock-inbound": {
	this.opts.channelManager?.mockInbound((event as any).id, (event as any).chatId, (event as any).text);
	reply({ type: "ok" } as any);
	break;
}
case "channels:mock-outbox": {
	const messages = this.opts.channelManager?.mockOutbox((event as any).id) ?? [];
	reply({ type: "ok", messages } as any);
	break;
}
```

注意：`callApi` 对 `{type:"error"}` 帧返回 400、业务 reply 最后一帧返回 200，路由层无需处理状态码。mock 两个事件类型未进 `WSClientEvent` 联合（测试专用），case 内用 `as any` 兜底。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd packages/kernel && bun test tests/routes-channels.test.ts && bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/routes/channels.ts packages/kernel/src/ws-server.ts packages/kernel/tests/routes-channels.test.ts
git commit -m "feat(kernel): 渠道 REST 路由与业务 case、智能体引用计数、mock 测试端点"
```

---

### Task 8: WecomAdapter + kernel 启动接线

**Files:**
- Create: `packages/kernel/src/channels/wecom-adapter.ts`
- Modify: `packages/kernel/package.json`（加依赖 `@wecom/aibot-node-sdk@^1.0.7`）
- Modify: `packages/kernel/src/index.ts`（`:83-89` 实例化区、`:158-176` 循环依赖回填区、`:193-207` onEvent 挂钩、`:291-301` shutdown）
- Test: `packages/kernel/tests/wecom-adapter.test.ts`（仅测消息归一化纯逻辑，不连真实 WS）

**Interfaces:**
- Consumes: `ChannelAdapter/InboundMessage`（Task 4）；`ChannelManager`（Task 6）；`@wecom/aibot-node-sdk` 的 `WSClient/generateReqId/WsFrame/TextMessage/ImageMessage`
- Produces: `WecomAdapter implements ChannelAdapter`；`normalizeInbound(frame): InboundMessage | null`（导出供单测）；kernel 启动后自动拉起 enabled 渠道

- [ ] **Step 1: 装依赖**

Run: `cd packages/kernel && bun add @wecom/aibot-node-sdk@^1.0.7`
Expected: package.json 出现该依赖

- [ ] **Step 2: 写失败测试（归一化逻辑）**

`packages/kernel/tests/wecom-adapter.test.ts`：

```ts
import { expect, test } from "bun:test";
import { normalizeInbound } from "../src/channels/wecom-adapter";

test("单聊文本：chatId=userid，原样保留文本", () => {
	const msg = normalizeInbound({
		headers: { req_id: "r1" },
		body: {
			msgid: "m1",
			chattype: "single",
			from: { userid: "zhangsan" },
			msgtype: "text",
			text: { content: "你好" },
		},
	});
	expect(msg).toMatchObject({
		chatId: "zhangsan",
		chatType: "single",
		text: "你好",
		msgId: "m1",
	});
});

test("群聊文本：chatId=群id，剥离 @机器人 前缀", () => {
	const msg = normalizeInbound({
		headers: { req_id: "r2" },
		body: {
			msgid: "m2",
			chattype: "group",
			chatid: "wr_abc",
			from: { userid: "zhangsan" },
			msgtype: "text",
			text: { content: "@客服机器人 在吗" },
		},
	});
	expect(msg!.chatId).toBe("wr_abc");
	expect(msg!.text).toBe("在吗");
});

test("图片消息：image 字段携带 url+aeskey", () => {
	const msg = normalizeInbound({
		headers: { req_id: "r3" },
		body: {
			msgid: "m3",
			chattype: "single",
			from: { userid: "u1" },
			msgtype: "image",
			image: { url: "https://x", aeskey: "k" },
		},
	});
	expect(msg!.image).toEqual({ url: "https://x", aeskey: "k", name: "m3.png" });
});

test("voice/file 等 → unsupported；空文本 → null", () => {
	const voice = normalizeInbound({
		headers: { req_id: "r4" },
		body: { msgid: "m4", chattype: "single", from: { userid: "u1" }, msgtype: "voice" },
	});
	expect(voice!.unsupported).toBe("voice");
	const empty = normalizeInbound({
		headers: { req_id: "r5" },
		body: { msgid: "m5", chattype: "single", from: { userid: "u1" }, msgtype: "text", text: { content: "  " } },
	});
	expect(empty).toBeNull();
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/wecom-adapter.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现**

`packages/kernel/src/channels/wecom-adapter.ts`：

```ts
import {
	generateReqId,
	WSClient,
	type WsFrame,
} from "@wecom/aibot-node-sdk";
import type { ChannelConfig, ChannelStatus } from "@wa-pi/shared";
import type {
	ChannelAdapter,
	ChannelImageRef,
	InboundMessage,
} from "./types";

/**
 * 企微帧 → 渠道无关进站消息。
 * 群聊 chatId 取 body.chatid、单聊取 from.userid；群聊文本剥离 "@机器人名" 前缀；
 * 不支持的类型（voice/file/video/mixed 等）置 unsupported；空文本返回 null（不处理）。
 */
export function normalizeInbound(frame: WsFrame): InboundMessage | null {
	const body = frame.body ?? {};
	const chatType: "single" | "group" = body.chattype === "group" ? "group" : "single";
	const chatId = chatType === "group" ? body.chatid : body.from?.userid;
	if (!chatId) return null;
	const base = {
		chatId,
		chatType,
		fromUserId: body.from?.userid ?? "",
		msgId: body.msgid ?? "",
		replyFrame: frame,
	};
	switch (body.msgtype) {
		case "text": {
			let text: string = body.text?.content ?? "";
			if (chatType === "group") text = text.replace(/^@\S+\s*/, ""); // 剥离 @机器人 前缀
			if (!text.trim()) return null;
			return { ...base, text };
		}
		case "image":
			return {
				...base,
				image: {
					url: body.image?.url ?? "",
					aeskey: body.image?.aeskey,
					name: `${body.msgid}.png`,
				},
			};
		default:
			return { ...base, unsupported: String(body.msgtype ?? "unknown") };
	}
}

/** 企业微信智能机器人适配器：官方 WS 长连接，无需公网回调 */
export class WecomAdapter implements ChannelAdapter {
	readonly type = "wecom" as const;
	private client: WSClient;
	private msgCb?: (msg: InboundMessage) => void;
	private statusCb?: (status: ChannelStatus, detail?: string) => void;

	constructor(channel: ChannelConfig) {
		this.client = new WSClient({
			botId: channel.credentials.botId,
			secret: channel.credentials.secret,
			maxReconnectAttempts: -1, // 无限重连（指数退避，SDK 内置上限 30s）
			logger: {
				debug: () => {},
				info: (...a: any[]) => console.log("[wecom]", ...a),
				warn: (...a: any[]) => console.warn("[wecom]", ...a),
				error: (...a: any[]) => console.error("[wecom]", ...a),
			},
		});
	}

	async connect(): Promise<void> {
		this.client.on("message", (frame: WsFrame) => {
			const msg = normalizeInbound(frame);
			if (msg) this.msgCb?.(msg);
		});
		this.client.on("authenticated", () => this.statusCb?.("connected"));
		this.client.on("disconnected", () => this.statusCb?.("connecting"));
		this.client.on("reconnecting", () => this.statusCb?.("connecting"));
		// 同一 Bot ID 在别处连接被踢下线
		this.client.on("event.disconnected_event", () =>
			this.statusCb?.("error", "连接被顶替：同一 Bot ID 已在别处连接"),
		);
		this.client.on("error", (err: Error) => this.statusCb?.("error", err.message));
		this.client.connect();
	}

	async disconnect(): Promise<void> {
		(this.client as any).disconnect?.();
	}

	/** 一次性 markdown 回复 = 流式回复直接 finish（企微被动回复不支持纯 text） */
	async sendText(replyFrame: unknown, markdown: string): Promise<void> {
		await this.client.replyStream(
			replyFrame as WsFrame,
			generateReqId("stream"),
			markdown,
			true,
		);
	}

	async downloadImage(image: ChannelImageRef): Promise<Buffer> {
		const { buffer } = await this.client.downloadFile(image.url, image.aeskey);
		return buffer;
	}

	onMessage(cb: (msg: InboundMessage) => void): void {
		this.msgCb = cb;
	}
	onStatus(cb: (status: ChannelStatus, detail?: string) => void): void {
		this.statusCb = cb;
	}
}
```

`packages/kernel/src/index.ts` 接线：

```ts
// 1) 实例化区（:83-89 一带）无需提前；在 agentManager 创建（:158-176 回填区）之后加：
const channelManager = new ChannelManager({
	configStore,
	projectStore,
	agentManager,
	broadcast,
	adapterFactories: {
		wecom: (c) => new WecomAdapter(c),
		...(process.env.WA_PI_CHANNELS_MOCK === "1"
			? { mock: (c) => new MockAdapter(c) }
			: {}),
	},
});
(server as any).opts.channelManager = channelManager; // 与 agentManager 同模式回填

// 2) onEvent 挂钩（:193-207 的回调体内、eventThrottle.handle 之前——agent_end 不可被节流丢弃）：
channelManager.onSessionEvent(sessionId, event);

// 3) server.start()（:266）之后：
await channelManager.start();

// 4) shutdown（:291-301）在 agentManager.disposeAll() 之前加：
await channelManager.stop().catch(() => {});
```

- [ ] **Step 5: 跑测试 + 全量回归 + kernel 启动冒烟**

Run: `cd packages/kernel && bun test && timeout 15 bun run src/index.ts || true`
Expected: 测试 PASS；kernel 正常启动监听 9776（无渠道时 ChannelManager 空转不报错）

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/channels/wecom-adapter.ts packages/kernel/src/index.ts packages/kernel/package.json bun.lock packages/kernel/tests/wecom-adapter.test.ts
git commit -m "feat(kernel): 企业微信适配器（WS 长连接）与启动接线"
```

---

### Task 9: 前端 channels store + SSE 接入

**Files:**
- Create: `packages/frontend/src/store/channels.ts`
- Modify: `packages/frontend/src/App.tsx`（`onMessage` 分发 switch，约 :110-259）
- Test: `packages/frontend/tests/channels-store.test.ts`

**Interfaces:**
- Consumes: Task 7 的 HTTP 契约；`api.get/post/put/del`（`api-client.ts`，删除是 `del`）；`onEventType`（`events.ts:98-110`）
- Produces（Task 10/11 依赖）：`useChannelsStore`，字段 `bots: ChannelStatusInfo[]`、`conversations: ChannelConversationInfo[]`；动作 `loadBots/loadConversations/createBot/updateBot/deleteBot`；全部动作失败时抛 `ApiError`（调用方展示 `e.message`）

- [ ] **Step 1: 写失败测试**

`packages/frontend/tests/channels-store.test.ts`（mock `api-client` 模块）：

```ts
import { beforeEach, expect, mock, test } from "bun:test";

const calls: { method: string; path: string; body?: any }[] = [];
mock.module("../src/api-client", () => ({
	api: {
		get: async (path: string) => {
			calls.push({ method: "GET", path });
			if (path === "/api/channels") {
				return { type: "channels:current", channels: [{ id: "ch_1", name: "客服" }] };
			}
			if (path === "/api/channel-conversations") {
				return { type: "channel-conversations:current", conversations: [{ sessionId: "s1" }] };
			}
			return {};
		},
		post: async (path: string, body: any) => {
			calls.push({ method: "POST", path, body });
			return { type: "channels:current", channels: [] };
		},
		put: async (path: string, body: any) => {
			calls.push({ method: "PUT", path, body });
			return { type: "channels:current", channels: [] };
		},
		del: async (path: string) => {
			calls.push({ method: "DELETE", path });
			return { type: "channels:current", channels: [] };
		},
	},
}));

const { useChannelsStore } = await import("../src/store/channels");

beforeEach(() => {
	calls.length = 0;
	useChannelsStore.setState({ bots: [], conversations: [] });
});

test("loadBots/loadConversations：拉取并写入 store", async () => {
	await useChannelsStore.getState().loadBots();
	await useChannelsStore.getState().loadConversations();
	expect(useChannelsStore.getState().bots[0].name).toBe("客服");
	expect(useChannelsStore.getState().conversations[0].sessionId).toBe("s1");
});

test("createBot：POST 载荷正确；deleteBot 走 api.del", async () => {
	await useChannelsStore.getState().createBot({ name: "x" } as any);
	expect(calls[0]).toMatchObject({ method: "POST", path: "/api/channels" });
	expect(calls[0].body.channel.name).toBe("x");
	await useChannelsStore.getState().deleteBot("ch_1");
	expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: "/api/channels/ch_1" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun test tests/channels-store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 store + App SSE 接入**

`packages/frontend/src/store/channels.ts`：

```ts
import { create } from "zustand";
import { api } from "../api-client";
import type {
	ChannelConfig,
	ChannelConversationInfo,
	ChannelStatusInfo,
} from "@wa-pi/shared";

/** 新建/更新渠道的入参（id/createdAt 由 kernel 生成） */
export type ChannelInput = Omit<ChannelConfig, "id" | "createdAt">;

interface ChannelsState {
	bots: ChannelStatusInfo[];
	conversations: ChannelConversationInfo[];
	loadBots: () => Promise<void>;
	loadConversations: () => Promise<void>;
	createBot: (channel: ChannelInput) => Promise<void>;
	updateBot: (id: string, patch: Partial<ChannelInput>) => Promise<void>;
	deleteBot: (id: string) => Promise<void>;
}

export const useChannelsStore = create<ChannelsState>((set) => ({
	bots: [],
	conversations: [],
	loadBots: async () => {
		const res = (await api.get("/api/channels")) as any;
		set({ bots: res?.channels ?? [] });
	},
	loadConversations: async () => {
		const res = (await api.get("/api/channel-conversations")) as any;
		set({ conversations: res?.conversations ?? [] });
	},
	createBot: async (channel) => {
		const res = (await api.post("/api/channels", { channel })) as any;
		set({ bots: res?.channels ?? [] });
	},
	updateBot: async (id, patch) => {
		const res = (await api.put(`/api/channels/${id}`, { channel: patch })) as any;
		set({ bots: res?.channels ?? [] });
	},
	deleteBot: async (id) => {
		const res = (await api.del(`/api/channels/${id}`)) as any;
		set({ bots: res?.channels ?? [] });
	},
}));
```

`packages/frontend/src/App.tsx` 的 `onMessage` switch（:110-259）加两个 case（回调内一律 `getState()` 取最新 action，App.tsx:46 既有约定）：

```tsx
case "channels:changed":
	void useChannelsStore.getState().loadBots();
	break;
case "channel-conversations:changed":
	void useChannelsStore.getState().loadConversations();
	break;
```

- [ ] **Step 4: 跑测试确认通过 + 前端全量回归**

Run: `cd packages/frontend && bun test tests/channels-store.test.ts && bun test --isolate`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/store/channels.ts packages/frontend/src/App.tsx packages/frontend/tests/channels-store.test.ts
git commit -m "feat(frontend): channels store 与 SSE 变更事件接入"
```

---

### Task 10: 设置页「机器人」Section + 新建弹层 + 渠道图标

**Files:**
- Create: `packages/frontend/public/channels/wecom.ico`、`feishu.ico`、`wechat.svg`、`qq.svg`（从 `docs/superpowers/specs/assets/2026-08-06-im-channel-bot/` 复制）
- Create: `packages/frontend/src/components/settings/BotsSection.tsx`
- Create: `packages/frontend/src/components/settings/NewBotDialog.tsx`
- Modify: `packages/frontend/src/store/settings.ts:3-10`（联合加 `"bots"`）
- Modify: `packages/frontend/src/components/SettingsModal.tsx`（nav 加项 + 条件渲染）
- Test: `packages/frontend/tests/BotsSection.test.tsx`

**Interfaces:**
- Consumes: `useChannelsStore`（Task 9）；`useAgentsStore`（`store/agents.ts`，`list: AgentConfig[]`）；`useProvidersStore`（模型选项，`resolveProviderSlug` 来自 `@wa-pi/shared`，参照 `ModelSelector.tsx:18-30`）；`ConfirmDialog`（props：`{title, message, confirmText?, cancelText?, danger?, onConfirm, onCancel}`，testid `confirm-dialog`/`confirm-ok`）
- Produces: 设置页「机器人」Section（testid：`settings-nav-bots`、`bots-new-btn`、`bot-card-<id>`、`bot-name-input`、`bot-botid-input`、`bot-secret-input`、`bot-agent-select`、`bot-model-select`、`bot-prompt-textarea`、`bot-granularity-select`、`bot-enabled-toggle`、`bot-save-btn`、`bot-delete-btn`）；新建弹层（`new-bot-dialog`、`channel-chip-wecom`、`channel-chip-wechat/feishu/qq`）

- [ ] **Step 1: 复制图标 + 写失败测试**

```bash
mkdir -p packages/frontend/public/channels
cp docs/superpowers/specs/assets/2026-08-06-im-channel-bot/{wecom.ico,feishu.ico,wechat.svg,qq.svg} packages/frontend/public/channels/
```

`packages/frontend/tests/BotsSection.test.tsx`（preset store + mock api；happy-dom 环境）：

```tsx
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiCalls: { method: string; path: string; body?: any }[] = [];
mock.module("../src/api-client", () => ({
	api: {
		get: async (path: string) => {
			if (path === "/api/channels") return { channels: [] };
			if (path === "/api/channel-conversations") return { conversations: [] };
			return {};
		},
		post: async (path: string, body: any) => {
			apiCalls.push({ method: "POST", path, body });
			return { channels: [{ id: "ch_new", ...body.channel }] };
		},
		put: async () => ({ channels: [] }),
		del: async () => ({ channels: [] }),
	},
}));

const { BotsSection } = await import("../src/components/settings/BotsSection");
const { useChannelsStore } = await import("../src/store/channels");
const { useAgentsStore } = await import("../src/store/agents");

beforeEach(() => {
	apiCalls.length = 0;
	useChannelsStore.setState({ bots: [], conversations: [] });
	useAgentsStore.setState({
		list: [
			{ displayName: "前端开发者", model: "p/m" },
			{ displayName: "后端架构师", model: null },
		] as any,
	});
});
afterEach(() => cleanup());

test("空列表渲染 + 新建按钮打开渠道选择弹层", () => {
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bots-new-btn"));
	expect(screen.getByTestId("new-bot-dialog")).toBeTruthy();
	// 企微可选，其余置灰
	expect(screen.getByTestId("channel-chip-wecom").getAttribute("data-disabled")).toBe("false");
	expect(screen.getByTestId("channel-chip-feishu").getAttribute("data-disabled")).toBe("true");
});

test("选择企微后填写表单并保存 → POST 正确载荷", async () => {
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bots-new-btn"));
	fireEvent.click(screen.getByTestId("channel-chip-wecom"));
	fireEvent.change(screen.getByTestId("bot-name-input"), { target: { value: "客服机器人" } });
	fireEvent.change(screen.getByTestId("bot-botid-input"), { target: { value: "ww123" } });
	fireEvent.change(screen.getByTestId("bot-secret-input"), { target: { value: "sec456" } });
	fireEvent.click(screen.getByTestId("bot-save-btn"));
	// handleSave 是异步的，等待 api 调用发生
	const { waitFor } = await import("@testing-library/react");
	await waitFor(() => expect(apiCalls.length).toBe(1));
	expect(apiCalls[0].path).toBe("/api/channels");
	expect(apiCalls[0].body.channel).toMatchObject({
		type: "wecom",
		name: "客服机器人",
		credentials: { botId: "ww123", secret: "sec456" },
		replyGranularity: "standard",
		enabled: true,
	});
});

test("关联智能体已删除 → 显示降级警告条", () => {
	useChannelsStore.setState({
		bots: [
			{
				id: "ch_1", type: "wecom", name: "老机器人", enabled: false,
				credentials: { botId: "b", secret: "****" },
				agentName: "已被删除的智能体", model: null,
				extraSystemPrompt: "", replyGranularity: "simple", createdAt: 1,
				status: "disconnected",
			} as any,
		],
	});
	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bot-card-ch_1"));
	expect(screen.getByTestId("bot-agent-missing-warning")).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun test tests/BotsSection.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现**

`packages/frontend/src/store/settings.ts`：`SettingsSection` 联合加 `| "bots"`。

`packages/frontend/src/components/SettingsModal.tsx`：nav 在「MCP 连接器」按钮后加：

```tsx
<button
	onClick={() => setSection("bots")}
	className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
	style={activeSection === "bots"
		? { background: "var(--surface-hover)", color: "var(--brand)" }
		: { color: "var(--secondary)" }}
	data-testid="settings-nav-bots"
>机器人</button>
```

右侧条件渲染区加 `{activeSection === "bots" && <BotsSection />}`，import 相应组件。

`packages/frontend/src/components/settings/NewBotDialog.tsx`（渠道选择弹层；企微可用，其余 `data-disabled="true"` + 「敬请期待」徽标 + 灰度滤镜）：

```tsx
import { Modal } from "../ui/Modal";
import type { ChannelType } from "@wa-pi/shared";

interface Props {
	onSelect: (type: ChannelType) => void;
	onClose: () => void;
}

const CHANNELS: { type: ChannelType; name: string; icon: string; enabled: boolean; hint: string }[] = [
	{ type: "wecom", name: "企业微信", icon: "/channels/wecom.ico", enabled: true, hint: "Bot ID + Secret · 长连接" },
	{ type: "wechat", name: "微信", icon: "/channels/wechat.svg", enabled: false, hint: "" },
	{ type: "feishu", name: "飞书", icon: "/channels/feishu.ico", enabled: false, hint: "" },
	{ type: "qq", name: "QQ", icon: "/channels/qq.svg", enabled: false, hint: "" },
];

export function NewBotDialog({ onSelect, onClose }: Props) {
	return (
		<Modal onClose={onClose} width={420} data-testid="new-bot-dialog">
			<div className="p-4 border-b border-hairline">
				<span className="text-primary font-bold text-sm">选择渠道类型</span>
			</div>
			<div className="p-3 flex flex-col gap-2">
				{CHANNELS.map((c) => (
					<button
						key={c.type}
						disabled={!c.enabled}
						onClick={() => c.enabled && onSelect(c.type)}
						className="flex items-center gap-2.5 px-3 py-2.5 rounded-md border border-hairline text-left transition-colors"
						style={c.enabled
							? { background: "var(--surface)", cursor: "pointer" }
							: { background: "var(--surface-elevated)", color: "var(--text-tertiary)", cursor: "not-allowed" }}
						data-testid={`channel-chip-${c.type}`}
						data-disabled={String(!c.enabled)}
					>
						<img
							src={c.icon}
							alt={c.name}
							className="w-5 h-5 rounded"
							style={c.enabled ? undefined : { filter: "grayscale(1)", opacity: 0.45 }}
						/>
						<span className="text-sm">{c.name}</span>
						{c.hint && <span className="text-xs text-tertiary">{c.hint}</span>}
						{!c.enabled && (
							<span className="ml-auto text-xs text-tertiary border border-hairline rounded-pill px-2 py-0.5">敬请期待</span>
						)}
					</button>
				))}
			</div>
		</Modal>
	);
}
```

`packages/frontend/src/components/settings/BotsSection.tsx`（左列表右表单，控件风格严格仿 `GeneralSection.tsx`：`px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm`）：

```tsx
import { useEffect, useState } from "react";
import { resolveProviderSlug, type ChannelType } from "@wa-pi/shared";
import { useChannelsStore, type ChannelInput } from "../../store/channels";
import { useAgentsStore } from "../../store/agents";
import { useProvidersStore } from "../../store/providers";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { NewBotDialog } from "./NewBotDialog";

const STATUS_DOT: Record<string, string> = {
	connected: "var(--success)",
	connecting: "var(--warning)",
	error: "var(--danger)",
	disconnected: "var(--hairline-strong)",
};
const STATUS_TEXT: Record<string, string> = {
	connected: "已连接", connecting: "连接中", error: "异常", disconnected: "未连接",
};

/** 新建草稿的默认值 */
function emptyDraft(type: ChannelType): ChannelInput {
	return {
		type, name: "", enabled: true,
		credentials: { botId: "", secret: "" },
		agentName: "", model: null,
		extraSystemPrompt: "", replyGranularity: "standard",
	};
}

export function BotsSection() {
	const bots = useChannelsStore((s) => s.bots);
	const { loadBots, createBot, updateBot, deleteBot } = useChannelsStore.getState();
	const agents = useAgentsStore((s) => s.list);
	const providers = useProvidersStore((s) => s.providers);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [draft, setDraft] = useState<ChannelInput | null>(null); // 非 null = 新建/编辑中的表单
	const [showNew, setShowNew] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => { void loadBots(); }, []);

	// 模型选项（与 ModelSelector 同源：providerSlug/modelId），首项「跟随智能体」
	const modelOptions = (() => {
		const slugs: string[] = [];
		return providers.flatMap((p) => {
			const slug = resolveProviderSlug(p, slugs);
			slugs.push(slug);
			return p.models.map((m) => ({ value: `${slug}/${m.id}`, label: `${p.name} / ${m.id}` }));
		});
	})();

	const selected = bots.find((b) => b.id === selectedId);
	// 编辑已有机型：表单初始值 = 渠道当前值（secret 已脱敏，留空表示不修改）
	const openEdit = (id: string) => {
		const b = bots.find((x) => x.id === id)!;
		setSelectedId(id);
		setDraft({
			type: b.type, name: b.name, enabled: b.enabled,
			credentials: { botId: b.credentials.botId, secret: "" },
			agentName: b.agentName, model: b.model,
			extraSystemPrompt: b.extraSystemPrompt, replyGranularity: b.replyGranularity,
		});
		setError(null);
	};

	const handleSave = async () => {
		if (!draft) return;
		setError(null);
		try {
			if (selectedId) {
				// secret 留空 = 不修改（kernel 侧 merge）
				const patch: any = { ...draft };
				if (!patch.credentials.secret) {
					patch.credentials = { botId: draft.credentials.botId };
				}
				await updateBot(selectedId, patch);
			} else {
				await createBot(draft);
			}
			setDraft(null);
			setSelectedId(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const agentMissing = draft?.agentName
		? !agents.some((a) => a.displayName === draft.agentName)
		: false;

	return (
		<div className="flex flex-1 min-h-0">
			{/* 左：机器人列表 */}
			<div className="w-56 border-r border-hairline p-3 flex flex-col gap-2" style={{ background: "var(--surface-elevated)" }}>
				<button
					onClick={() => setShowNew(true)}
					className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
					style={{ background: "var(--brand)", color: "var(--on-brand)" }}
					data-testid="bots-new-btn"
				>＋ 新建机器人</button>
				{bots.map((b) => (
					<button
						key={b.id}
						onClick={() => openEdit(b.id)}
						className="text-left px-2.5 py-2 rounded-md border cursor-pointer"
						style={{
							borderColor: selectedId === b.id ? "var(--hairline-strong)" : "var(--hairline)",
							background: "var(--surface)",
						}}
						data-testid={`bot-card-${b.id}`}
					>
						<div className="flex items-center gap-1.5 text-sm font-medium text-primary">
							<img src={`/channels/${b.type}.ico`} alt="" className="w-4 h-4 rounded" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
							{b.name}
						</div>
						<div className="flex items-center gap-1 mt-1 text-xs text-tertiary">
							<span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: STATUS_DOT[b.status] }} />
							{STATUS_TEXT[b.status]}{b.statusDetail ? ` · ${b.statusDetail}` : ""}
						</div>
					</button>
				))}
			</div>

			{/* 右：表单 */}
			<div className="flex-1 flex flex-col gap-3 p-4 overflow-auto">
				{!draft && <div className="text-sm text-tertiary p-4">选择左侧机器人进行配置，或新建一个。</div>}
				{draft && (
					<>
						<label className="flex flex-col gap-1 w-72">
							<span className="text-xs text-secondary">名称</span>
							<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
								className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
								data-testid="bot-name-input" />
						</label>
						<div className="flex gap-3">
							<label className="flex flex-col gap-1 w-56">
								<span className="text-xs text-secondary">Bot ID</span>
								<input value={draft.credentials.botId}
									onChange={(e) => setDraft({ ...draft, credentials: { ...draft.credentials, botId: e.target.value } })}
									className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
									data-testid="bot-botid-input" />
							</label>
							<label className="flex flex-col gap-1 w-56">
								<span className="text-xs text-secondary">Secret{selectedId ? "（留空不修改）" : ""}</span>
								<input type="password" value={draft.credentials.secret}
									onChange={(e) => setDraft({ ...draft, credentials: { ...draft.credentials, secret: e.target.value } })}
									className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
									data-testid="bot-secret-input" />
							</label>
						</div>
						<label className="flex flex-col gap-1 w-72">
							<span className="text-xs text-secondary">关联智能体</span>
							<select value={draft.agentName}
								onChange={(e) => setDraft({ ...draft, agentName: e.target.value })}
								className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
								data-testid="bot-agent-select">
								<option value="">系统默认（列表第一项）</option>
								{agents.map((a) => <option key={a.displayName} value={a.displayName}>{a.displayName}</option>)}
							</select>
							{agentMissing && (
								<span className="text-xs px-2 py-1 rounded-sm" style={{ background: "var(--warning-soft)", color: "var(--warning)" }}
									data-testid="bot-agent-missing-warning">
									⚠️ 原智能体已删除，当前降级使用系统默认智能体
								</span>
							)}
						</label>
						<label className="flex flex-col gap-1 w-72">
							<span className="text-xs text-secondary">模型</span>
							<select value={draft.model ?? ""}
								onChange={(e) => setDraft({ ...draft, model: e.target.value || null })}
								className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
								data-testid="bot-model-select">
								<option value="">跟随智能体</option>
								{modelOptions.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
							</select>
						</label>
						<label className="flex flex-col gap-1 w-full max-w-lg">
							<span className="text-xs text-secondary">额外系统提示词</span>
							<textarea value={draft.extraSystemPrompt} rows={3}
								onChange={(e) => setDraft({ ...draft, extraSystemPrompt: e.target.value })}
								className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
								data-testid="bot-prompt-textarea" />
							<span className="text-xs text-tertiary">追加拼接到系统提示词中，位于记忆内容之前。</span>
						</label>
						<label className="flex flex-col gap-1 w-72">
							<span className="text-xs text-secondary">回复粒度</span>
							<select value={draft.replyGranularity}
								onChange={(e) => setDraft({ ...draft, replyGranularity: e.target.value as any })}
								className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
								data-testid="bot-granularity-select">
								<option value="standard">标准回复 · 正文 + 文件变更</option>
								<option value="simple">简洁回复 · 仅正文</option>
							</select>
						</label>
						<label className="flex items-center gap-2 text-sm text-secondary">
							<input type="checkbox" checked={draft.enabled}
								onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
								data-testid="bot-enabled-toggle" />
							启用（保存后生效）
						</label>
						<div className="flex items-center gap-3 border-t border-hairline pt-3">
							{selectedId && (
								<button onClick={() => setConfirmDelete(true)}
									className="px-3 py-1.5 rounded-sm text-sm border border-hairline cursor-pointer"
									style={{ color: "var(--danger)" }}
									data-testid="bot-delete-btn">删除机器人</button>
							)}
							<span className="flex-1" />
							<button onClick={() => void handleSave()}
								className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
								style={{ background: "var(--brand)", color: "var(--on-brand)" }}
								data-testid="bot-save-btn">保存</button>
							{error && <span className="text-xs" style={{ color: "var(--danger)" }} data-testid="bot-save-error">{error}</span>}
						</div>
					</>
				)}
			</div>

			{showNew && (
				<NewBotDialog
					onClose={() => setShowNew(false)}
					onSelect={(type) => { setShowNew(false); setSelectedId(null); setDraft(emptyDraft(type)); setError(null); }}
				/>
			)}
			{confirmDelete && selectedId && (
				<ConfirmDialog
					title="删除机器人"
					message={`确定删除「${selected?.name}」吗？历史会话保留，但机器人将断开连接。`}
					confirmText="删除"
					danger
					onCancel={() => setConfirmDelete(false)}
					onConfirm={() => {
						void deleteBot(selectedId).then(() => {
							setConfirmDelete(false); setSelectedId(null); setDraft(null);
						});
					}}
				/>
			)}
		</div>
	);
}
```

注意：编辑时 secret 留空 = 不修改，对应的 credentials 合并逻辑已在 Task 6 的 `ChannelManager.update` 中实现（secret 缺省保留原值）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd packages/frontend && bun test tests/BotsSection.test.tsx && bun test --isolate`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/public/channels/ packages/frontend/src/components/settings/BotsSection.tsx packages/frontend/src/components/settings/NewBotDialog.tsx packages/frontend/src/store/settings.ts packages/frontend/src/components/SettingsModal.tsx packages/frontend/tests/BotsSection.test.tsx
git commit -m "feat(frontend): 设置页机器人 Section（列表/新建/编辑/删除/状态展示）"
```

---

### Task 10A: 补充提示词 `$` 技能自动补全输入框（frontend）

**Files:**
- Create: `packages/frontend/src/components/ui/SkillSuggestTextarea.tsx`
- Modify: `packages/frontend/src/components/settings/BotsSection.tsx`（提示词 textarea 换用新组件，testid `bot-prompt-textarea` 保持不变）
- Test: `packages/frontend/tests/SkillSuggestTextarea.test.tsx`

**Interfaces:**
- Consumes: `detectTrigger(text): { type, query } | null`（`quick-invoke/trigger.ts:26`，纯函数，只取 `type === "skill"` 的结果）；`filterItems(items, query)`（同文件 :65）；`useSkillsStore` 的 `skills`（已启用技能列表）与 `load()`（`store/skills.ts`）
- Produces: `SkillSuggestTextarea` 组件，props `{ value: string; onChange(v: string): void; rows?: number; placeholder?: string; "data-testid"?: string }`；testid：`skill-suggest-list`、`skill-suggest-item-<name>`

- [ ] **Step 1: 写失败测试**

`packages/frontend/tests/SkillSuggestTextarea.test.tsx`：

```tsx
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// 预设技能列表（组件内 skills 非空时不会触发 load 请求）
const { useSkillsStore } = await import("../src/store/skills");
const { SkillSuggestTextarea } = await import("../src/components/ui/SkillSuggestTextarea");

function Host() {
	const [v, setV] = (await import("react")).useState("");
	return <SkillSuggestTextarea value={v} onChange={setV} data-testid="ta" />;
}

beforeEach(() => {
	useSkillsStore.setState({
		skills: [
			{ name: "brainstorming", description: "头脑风暴", path: "/x" },
			{ name: "tdd", description: "测试驱动", path: "/y" },
		] as any,
	});
});
afterEach(() => cleanup());

test("输入 $ 触发技能列表；继续输入按名称过滤", () => {
	render(<Host />);
	const ta = screen.getByTestId("ta") as HTMLTextAreaElement;
	fireEvent.change(ta, { target: { value: "$" } });
	expect(screen.getByTestId("skill-suggest-list")).toBeTruthy();
	expect(screen.getByTestId("skill-suggest-item-brainstorming")).toBeTruthy();
	fireEvent.change(ta, { target: { value: "$td" } });
	expect(screen.queryByTestId("skill-suggest-item-brainstorming")).toBeNull();
	expect(screen.getByTestId("skill-suggest-item-tdd")).toBeTruthy();
});

test("点击技能项 → 插入 $[名] 替换 $query 片段", () => {
	render(<Host />);
	const ta = screen.getByTestId("ta") as HTMLTextAreaElement;
	fireEvent.change(ta, { target: { value: "你是客服。$brain" } });
	fireEvent.click(screen.getByTestId("skill-suggest-item-brainstorming"));
	expect(ta.value).toBe("你是客服。$[brainstorming]");
	expect(screen.queryByTestId("skill-suggest-list")).toBeNull();
});

test("无 $ 触发符 → 不出列表；Esc 关闭列表", () => {
	render(<Host />);
	const ta = screen.getByTestId("ta") as HTMLTextAreaElement;
	fireEvent.change(ta, { target: { value: "普通文本" } });
	expect(screen.queryByTestId("skill-suggest-list")).toBeNull();
	fireEvent.change(ta, { target: { value: "$t" } });
	expect(screen.getByTestId("skill-suggest-list")).toBeTruthy();
	fireEvent.keyDown(ta, { key: "Escape" });
	expect(screen.queryByTestId("skill-suggest-list")).toBeNull();
});
```

（happy-dom 中 `fireEvent.change` 后 `selectionStart` 位于文末；组件读取光标位置时用 `e.target.selectionStart ?? value.length` 兜底。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun test tests/SkillSuggestTextarea.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现**

`packages/frontend/src/components/ui/SkillSuggestTextarea.tsx`：

```tsx
import { useEffect, useRef, useState } from "react";
import { detectTrigger, filterItems } from "../../quick-invoke/trigger";
import { useSkillsStore } from "../../store/skills";

interface Props {
	value: string;
	onChange: (v: string) => void;
	rows?: number;
	placeholder?: string;
	"data-testid"?: string;
}

/** 支持 $ 技能自动补全的纯文本输入框（仅 skill 一种触发；存储形态为 $[技能名] 纯文本 token） */
export function SkillSuggestTextarea({ value, onChange, rows = 3, placeholder, "data-testid": testId }: Props) {
	const skills = useSkillsStore((s) => s.skills);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeIdx, setActiveIdx] = useState(0);
	const ref = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (skills.length === 0) useSkillsStore.getState().load();
	}, []);

	const items = open ? filterItems(skills, query) : [];

	const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const v = e.target.value;
		onChange(v);
		const cursor = e.target.selectionStart ?? v.length;
		const trigger = detectTrigger(v.slice(0, cursor));
		if (trigger?.type === "skill") {
			setQuery(trigger.query);
			setActiveIdx(0);
			setOpen(true);
		} else {
			setOpen(false);
		}
	};

	/** 把光标前的 $query 片段替换为 $[name] token */
	const pick = (name: string) => {
		const ta = ref.current!;
		const cursor = ta.selectionStart ?? value.length;
		const before = value.slice(0, cursor);
		const m = before.match(/(?:^|\s)([$¥])([^\s]*)$/);
		const start = m ? cursor - m[1].length - m[2].length : cursor;
		const token = `$[${name}]`;
		const next = value.slice(0, start) + token + value.slice(cursor);
		onChange(next);
		setOpen(false);
		// 光标移到 token 之后
		requestAnimationFrame(() => {
			ta.focus();
			ta.selectionStart = ta.selectionEnd = start + token.length;
		});
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (!open || items.length === 0) return;
		if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => (i + 1) % items.length); }
		else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => (i - 1 + items.length) % items.length); }
		else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(items[activeIdx].name); }
		else if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
	};

	return (
		<div className="relative">
			<textarea
				ref={ref}
				value={value}
				onChange={handleChange}
				onKeyDown={handleKeyDown}
				onBlur={() => setTimeout(() => setOpen(false), 150)} // 延迟关闭让点击先触发
				rows={rows}
				placeholder={placeholder}
				className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none w-full"
				data-testid={testId}
			/>
			{open && items.length > 0 && (
				<div
					className="absolute left-0 right-0 top-full mt-1 rounded-md border border-hairline overflow-hidden z-10"
					style={{ background: "var(--surface)", boxShadow: "var(--shadow-md)" }}
					data-testid="skill-suggest-list"
				>
					{items.map((s, i) => (
						<button
							key={s.name}
							onMouseDown={(e) => { e.preventDefault(); pick(s.name); }} // mousedown 抢在 blur 前
							className="w-full text-left px-2.5 py-1.5 border-0 cursor-pointer text-sm"
							style={{
								background: i === activeIdx ? "var(--surface-hover)" : "transparent",
								color: "var(--text-primary)",
							}}
							data-testid={`skill-suggest-item-${s.name}`}
						>
							⚡ {s.name}
							{s.description && <span className="text-xs text-tertiary ml-1.5">{s.description}</span>}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
```

`BotsSection.tsx`：提示词 label 内的 `<textarea … data-testid="bot-prompt-textarea" />` 替换为：

```tsx
<SkillSuggestTextarea
	value={draft.extraSystemPrompt}
	onChange={(v) => setDraft({ ...draft, extraSystemPrompt: v })}
	rows={3}
	data-testid="bot-prompt-textarea"
/>
```

（import 相应组件；原 textarea 的 className 说明文案「追加拼接到系统提示词中，位于记忆内容之前。」保留，并补一句「输入 $ 可引用技能」。）

- [ ] **Step 4: 跑测试确认通过 + BotsSection 既有测试回归**

Run: `cd packages/frontend && bun test tests/SkillSuggestTextarea.test.tsx tests/BotsSection.test.tsx && bun test --isolate`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/ui/SkillSuggestTextarea.tsx packages/frontend/src/components/settings/BotsSection.tsx packages/frontend/tests/SkillSuggestTextarea.test.tsx
git commit -m "feat(frontend): 渠道提示词输入框支持 $ 技能自动补全"
```

---

### Task 11: 侧边栏「任务 | IM」页签 + IM 会话列表 + 历史 100 条上限

**Files:**
- Modify: `packages/frontend/src/components/Sidebar.tsx:29-43`
- Create: `packages/frontend/src/components/ImConversationList.tsx`
- Modify: `packages/frontend/src/components/SessionView.tsx`（props + 消息截取 + 来源徽标，拉消息处约 :64-80）
- Modify: `packages/frontend/src/App.tsx`（SessionView 渲染处 :503-505 传参）
- Create: `packages/frontend/src/util/slice-history.ts`
- Test: `packages/frontend/tests/ImConversationList.test.tsx`、`packages/frontend/tests/slice-history.test.ts`

**Interfaces:**
- Consumes: `useChannelsStore.conversations`（Task 9）；`Sidebar` 既有 prop `onSelectSession(id)`（`App.tsx:419-422` 已接 `selectSession + setView("session")`，IM 列表直接复用）
- Produces:
  - 侧边栏分段控件（testid：`sidebar-tab-tasks`、`sidebar-tab-im`）
  - `ImConversationList`（testid：`im-conv-list`、列表项 `im-conv-<sessionId>`）
  - `SessionView` 新可选 props：`maxHistory?: number`、`sourceLabel?: string`（设置时 header 显示来源徽标 + 「仅显示最近 N 条」）
  - 纯函数 `sliceHistory<T>(messages: T[], max?: number): T[]`

- [ ] **Step 1: 写失败测试**

`packages/frontend/tests/slice-history.test.ts`：

```ts
import { expect, test } from "bun:test";
import { sliceHistory } from "../src/util/slice-history";

test("sliceHistory：未传 max 原样返回；超出则保留末尾 N 条", () => {
	const msgs = Array.from({ length: 150 }, (_, i) => ({ id: i }));
	expect(sliceHistory(msgs)).toHaveLength(150);
	const sliced = sliceHistory(msgs, 100);
	expect(sliced).toHaveLength(100);
	expect(sliced[0].id).toBe(50);
	expect(sliceHistory([{ id: 1 }], 100)).toHaveLength(1);
});
```

`packages/frontend/tests/ImConversationList.test.tsx`：

```tsx
import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

mock.module("../src/api-client", () => ({
	api: { get: async () => ({ conversations: [] }) },
}));

const { ImConversationList } = await import("../src/components/ImConversationList");
const { useChannelsStore } = await import("../src/store/channels");

afterEach(() => cleanup());

test("渲染会话项并点击回调 onSelectSession", () => {
	useChannelsStore.setState({
		conversations: [
			{
				channelId: "ch_1", channelName: "客服机器人", channelType: "wecom",
				chatId: "zhangsan", chatType: "single",
				sessionId: "sess_1", projectId: "__system__", projectName: "默认工作区",
				lastMessagePreview: "好的", updatedAt: Date.now(),
			},
			{
				channelId: "ch_1", channelName: "客服机器人", channelType: "wecom",
				chatId: "wr_abcdef123", chatType: "group",
				sessionId: "sess_2", projectId: "p1", projectName: "hiagent",
				lastMessagePreview: "收到", updatedAt: Date.now() - 86_400_000,
			},
		] as any,
	});
	const onSelect = mock();
	render(<ImConversationList onSelectSession={onSelect} />);
	// 单聊显示 userid；群聊显示 群聊(前8位)
	expect(screen.getByText("zhangsan")).toBeTruthy();
	expect(screen.getByText("群聊(wr_abcde)")).toBeTruthy();
	expect(screen.getByText(/hiagent/)).toBeTruthy();
	fireEvent.click(screen.getByTestId("im-conv-sess_1"));
	expect(onSelect).toHaveBeenCalledWith("sess_1");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/frontend && bun test tests/slice-history.test.ts tests/ImConversationList.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`packages/frontend/src/util/slice-history.ts`：

```ts
/** IM 会话历史截取：最多展示末尾 max 条；未传 max 原样返回 */
export function sliceHistory<T>(messages: T[], max?: number): T[] {
	if (!max || messages.length <= max) return messages;
	return messages.slice(-max);
}
```

`packages/frontend/src/components/ImConversationList.tsx`：

```tsx
import { useEffect } from "react";
import { useChannelsStore } from "../store/channels";
import type { ChannelConversationInfo } from "@wa-pi/shared";

interface Props {
	onSelectSession: (id: string) => void;
}

/** 列表项标题：单聊显示 userid；群聊显示 群聊(chatId 前8位)（v1 拿不到用户昵称） */
function titleOf(c: ChannelConversationInfo): string {
	return c.chatType === "group" ? `群聊(${c.chatId.slice(0, 8)})` : c.chatId;
}

function timeOf(ts: number): string {
	const d = new Date(ts);
	const today = new Date();
	if (d.toDateString() === today.toDateString()) {
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}
	return `${d.getMonth() + 1}-${d.getDate()}`;
}

export function ImConversationList({ onSelectSession }: Props) {
	const conversations = useChannelsStore((s) => s.conversations);
	useEffect(() => {
		void useChannelsStore.getState().loadConversations();
	}, []);

	if (conversations.length === 0) {
		return <div className="p-4 text-center text-xs text-tertiary">暂无 IM 会话。在设置页配置机器人后，来自 IM 的对话会出现在这里。</div>;
	}
	return (
		<div className="flex flex-col gap-1 overflow-auto" data-testid="im-conv-list">
			{conversations.map((c) => (
				<button
					key={c.sessionId}
					onClick={() => onSelectSession(c.sessionId)}
					className="flex items-center gap-2 px-2 py-2 rounded-md text-left cursor-pointer border-0"
					style={{ background: "transparent" }}
					data-testid={`im-conv-${c.sessionId}`}
				>
					<img src={`/channels/${c.channelType}.ico`} alt="" className="w-6 h-6 rounded"
						onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
					<span className="min-w-0 flex-1">
						<span className="block text-sm font-medium text-primary truncate">{titleOf(c)}</span>
						<span className="block text-xs text-tertiary truncate">
							{c.channelName} · {c.projectName} · {c.lastMessagePreview}
						</span>
					</span>
					<span className="text-xs text-tertiary flex-none">{timeOf(c.updatedAt)}</span>
				</button>
			))}
		</div>
	);
}
```

`packages/frontend/src/components/Sidebar.tsx`（:29-43 区域改动；Sidebar 是纯 props 壳，不动回调签名）：

```tsx
// 顶部 import 加：
import { useState } from "react";
import { ImConversationList } from "./ImConversationList";

// 组件内加本地状态：
const [tab, setTab] = useState<"tasks" | "im">("tasks");

// logo 头（:29-32）之后插入分段控件：
<div className="flex rounded-md p-0.5" style={{ background: "var(--surface-hover)" }}>
	{(["tasks", "im"] as const).map((t) => (
		<button
			key={t}
			onClick={() => setTab(t)}
			className="flex-1 text-xs font-medium py-1 rounded-sm border-0 cursor-pointer"
			style={tab === t
				? { background: "var(--surface)", color: "var(--text-primary)", boxShadow: "var(--shadow-sm)" }
				: { background: "transparent", color: "var(--text-secondary)" }}
			data-testid={t === "tasks" ? "sidebar-tab-tasks" : "sidebar-tab-im"}
		>{t === "tasks" ? "任务" : "IM"}</button>
	))}
</div>

// 原有 NewSessionButton + AgentListSection + ProjectList（:33-43）包条件：
{tab === "tasks" ? (
	<>
		<NewSessionButton onNewSession={props.onNewSession} />
		<AgentListSection onChatWith={props.onChatWith} onEdit={props.onEdit} onMore={props.onMore} />
		<ProjectList /* …原 props 不动… */ />
	</>
) : (
	<ImConversationList onSelectSession={props.onSelectSession} />
)}
// SettingsButton（:44）保持在条件分支外，两种页签都可见
```

`packages/frontend/src/components/SessionView.tsx`：

```tsx
// Props 加：
maxHistory?: number;
sourceLabel?: string;

// 拉消息处（:64-80）应用截取：
const msgs = sliceHistory(fetched, props.maxHistory);

// header 右侧现有胶囊区（token-capsule 一带）追加：
{props.sourceLabel && (
	<span className="token-capsule" data-testid="im-source-badge">{props.sourceLabel}</span>
)}
{props.maxHistory && (
	<span className="token-capsule">仅显示最近 {props.maxHistory} 条</span>
)}
```

`packages/frontend/src/App.tsx`（SessionView 渲染处 :503-505；conversations 用 hook 订阅保证响应式）：

```tsx
// 组件顶部与其他 store 订阅同处加：
const conversations = useChannelsStore((s) => s.conversations);
// import { useChannelsStore } from "./store/channels";

// 渲染处：
{view === "session" && currentSessionId && (() => {
	const imConv = conversations.find((c) => c.sessionId === currentSessionId);
	return (
		<SessionView
			sessionId={currentSessionId}
			maxHistory={imConv ? 100 : undefined}
			sourceLabel={imConv ? `经「${imConv.channelName}」接入` : undefined}
		/>
	);
})()}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd packages/frontend && bun test tests/slice-history.test.ts tests/ImConversationList.test.tsx && bun test --isolate`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/Sidebar.tsx packages/frontend/src/components/ImConversationList.tsx packages/frontend/src/components/SessionView.tsx packages/frontend/src/App.tsx packages/frontend/src/util/slice-history.ts packages/frontend/tests/ImConversationList.test.tsx packages/frontend/tests/slice-history.test.ts
git commit -m "feat(frontend): 侧边栏任务/IM 页签、IM 会话列表、IM 会话历史 100 条上限与来源徽标"
```

---

### Task 12: 智能体删除确认的渠道引用提示

**Files:**
- Modify: 智能体删除确认处（先定位：`grep -n "deleteAgent\|删除" packages/frontend/src/components/AgentListSection.tsx packages/frontend/src/components/AgentConfig.tsx packages/frontend/src/components/AgentGalleryModal.tsx`）
- Test: 在定位到的组件对应测试文件追加用例（无则新建 `packages/frontend/tests/agent-delete-warning.test.tsx`）

**Interfaces:**
- Consumes: `GET /api/channels/agent-usage/:agentName`（Task 7，返回 `{count, channelNames}`）；`useAgentsStore.deleteAgent(name)`（`store/agents.ts:36`）

- [ ] **Step 1: 写失败测试**

```tsx
// mock api：agent-usage 返回 count=2；渲染删除确认 → 断言提示文本
test("删除被渠道引用的智能体 → 确认文案含机器人引用提示", async () => {
	// 预设：GET /api/channels/agent-usage/前端开发者 → { count: 2, channelNames: ["客服机器人","测试机器人"] }
	// 触发删除确认 UI → 断言文本包含「2 个机器人」与「默认智能体」
});
```

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL（确认文案无引用提示）

- [ ] **Step 3: 实现**

在删除确认展示前调用用量接口，拼接提示（无引用则不提示）：

```tsx
const usage = (await api.get(
	`/api/channels/agent-usage/${encodeURIComponent(name)}`,
)) as any;
const hint =
	usage?.count > 0
		? `\n注意：该智能体正被 ${usage.count} 个机器人（${usage.channelNames.join("、")}）使用，删除后这些机器人将改用默认智能体。`
		: "";
// 既有确认文案 + hint 传入 ConfirmDialog 的 message
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd packages/frontend && bun test --isolate`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/components/ packages/frontend/tests/
git commit -m "feat(frontend): 删除智能体时提示被渠道机器人引用情况"
```

---

### Task 13: API 集成验收（curl）

**Files:**
- Create: `scripts/channels-api-it.sh`（提交入库，手工/CI 可重跑）

- [ ] **Step 1: 写集成脚本**

```bash
#!/usr/bin/env bash
# IM 渠道 API 集成验收：需先以 mock 模式启动 kernel：
#   WA_PI_CHANNELS_MOCK=1 WA_PI_DIR=$(mktemp -d) bun run --filter @wa-pi/kernel dev
set -euo pipefail
BASE="${1:-http://localhost:9776}"
fail() { echo "❌ $1"; exit 1; }

# 1) 缺 botId → 400
code=$(curl -s -o /tmp/ch-res.json -w "%{http_code}" -X POST "$BASE/api/channels" \
	-H "Content-Type: application/json" \
	-d '{"channel":{"type":"mock","name":"x","enabled":true,"credentials":{"botId":"","secret":"s"},"agentName":"","model":"p/m","extraSystemPrompt":"","replyGranularity":"standard"}}')
[ "$code" = "400" ] || fail "缺 botId 应返回 400，实际 $code"
grep -q "Bot ID" /tmp/ch-res.json || fail "错误信息应含 Bot ID"

# 2) 正常创建 → 200 且返回 id
curl -s -X POST "$BASE/api/channels" -H "Content-Type: application/json" \
	-d '{"channel":{"type":"mock","name":"验收机器人","enabled":true,"credentials":{"botId":"b1","secret":"secret-1234"},"agentName":"","model":"p/m","extraSystemPrompt":"","replyGranularity":"standard"}}' \
	> /tmp/ch-res.json
CH_ID=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/ch-res.json','utf8')).channels[0].id)")
[ -n "$CH_ID" ] || fail "创建后应返回渠道 id"

# 3) 列表脱敏
curl -s "$BASE/api/channels" > /tmp/ch-res.json
grep -q '\*\*\*\*1234' /tmp/ch-res.json || fail "secret 应脱敏为 ****1234"
grep -q "secret-1234\"" /tmp/ch-res.json && fail "明文 secret 泄漏"

# 4) 重复 Bot ID → 400
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/channels" \
	-H "Content-Type: application/json" \
	-d '{"channel":{"type":"mock","name":"y","enabled":true,"credentials":{"botId":"b1","secret":"s"},"agentName":"","model":"p/m","extraSystemPrompt":"","replyGranularity":"simple"}}')
[ "$code" = "400" ] || fail "重复 Bot ID 应返回 400，实际 $code"

# 5) 更新名称 → 200
code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE/api/channels/$CH_ID" \
	-H "Content-Type: application/json" -d '{"channel":{"name":"验收机器人2"}}')
[ "$code" = "200" ] || fail "更新应返回 200，实际 $code"

# 6) 智能体引用计数（本脚本创建的渠道 agentName 为空，应为 0）
curl -s "$BASE/api/channels/agent-usage/$(bun -e "console.log(encodeURIComponent('前端开发者'))")" > /tmp/ch-res.json
grep -q '"count":0' /tmp/ch-res.json || fail "agent-usage 应返回 count:0"

# 7) mock 进站 → outbox 有回复（无真实模型，预期为错误/配置类回复，链路通即可）
curl -s -X POST "$BASE/api/channels/$CH_ID/mock-inbound" -H "Content-Type: application/json" \
	-d '{"chatId":"u-it","text":"你好"}' > /dev/null
sleep 3
curl -s "$BASE/api/channels/$CH_ID/mock-outbox" > /tmp/ch-res.json
grep -q '"text"' /tmp/ch-res.json || fail "mock-outbox 应有回复记录"

# 8) 会话列表出现该对话
curl -s "$BASE/api/channel-conversations" > /tmp/ch-res.json
grep -q "u-it" /tmp/ch-res.json || fail "会话列表应包含 u-it"

# 9) 删除 → 列表为空
curl -s -X DELETE "$BASE/api/channels/$CH_ID" > /tmp/ch-res.json
[ "$(bun -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/ch-res.json','utf8')).channels.length)")" = "0" ] || fail "删除后列表应为空"

echo "✅ 渠道 API 集成验收全部通过"
```

- [ ] **Step 2: 跑脚本验收**

Run: `WA_PI_CHANNELS_MOCK=1 WA_PI_DIR=$(mktemp -d) bun run --filter @wa-pi/kernel dev &` 待端口就绪后 `bash scripts/channels-api-it.sh`，完毕 kill kernel
Expected: 输出「✅ 渠道 API 集成验收全部通过」；失败项按输出修复

- [ ] **Step 3: Commit**

```bash
git add scripts/channels-api-it.sh
git commit -m "test: 渠道 REST API curl 集成验收脚本"
```

---

### Task 14: Playwright E2E（mock 渠道全链路）

**Files:**
- Modify: `packages/frontend/e2e/global-setup.ts`（kernel spawn env 加 `WA_PI_CHANNELS_MOCK: "1"`）
- Create: `packages/frontend/e2e/channels.spec.ts`

**Interfaces:**
- Consumes: `helpers.ts` 的 `pollUntil`（:30-42）、`saveProvider`（:70-72）；设置页 testid（Task 10）；侧边栏 testid（Task 11）；mock 端点（Task 7）
- Produces: 可重复跑的 `channels.spec.ts`（`test.describe.serial`）

- [ ] **Step 1: global-setup 注入 mock 模式**

`packages/frontend/e2e/global-setup.ts` 的 kernel spawn env 数组加 `WA_PI_CHANNELS_MOCK: "1"`（与 `WA_PI_DIR` 等既有注入同处）。

- [ ] **Step 2: 写 E2E spec**

`packages/frontend/e2e/channels.spec.ts`：

```ts
import { expect, test } from "@playwright/test";
import { pollUntil } from "./helpers";

const KERNEL = `http://localhost:${process.env.WA_PI_E2E_WS_PORT ?? 9776}`;

test.describe.serial("IM 渠道机器人", () => {
	let channelId: string;

	test("设置页创建机器人（企微表单，假凭据）", async ({ page }) => {
		await page.goto("/");
		await page.getByTestId("settings-btn").click();
		await page.getByTestId("settings-nav-bots").click();
		await page.getByTestId("bots-new-btn").click();
		// 置灰项不可点
		await expect(page.getByTestId("channel-chip-feishu")).toHaveAttribute("data-disabled", "true");
		await page.getByTestId("channel-chip-wecom").click();
		await page.getByTestId("bot-name-input").fill("E2E机器人");
		await page.getByTestId("bot-botid-input").fill("ww-e2e-fake");
		await page.getByTestId("bot-secret-input").fill("fake-secret");
		await page.getByTestId("bot-save-btn").click();
		// 假凭据连接不上：卡片出现且状态非「已连接」，随后关掉启用开关避免重连噪音
		await expect(page.getByText("E2E机器人")).toBeVisible({ timeout: 5000 });
	});

	test("mock 渠道消息全链路：进站 → 回复 → 侧边栏 IM 页签 → 打开会话", async ({ page }) => {
		// REST 建 mock 渠道（enabled，model 指向 e2e 假 provider，回复为错误也算链路通）
		const res = await page.request.post(`${KERNEL}/api/channels`, {
			data: {
				channel: {
					type: "mock", name: "E2E-Mock", enabled: true,
					credentials: { botId: "mock-b", secret: "mock-s" },
					agentName: "dev", model: null, extraSystemPrompt: "",
					replyGranularity: "standard",
				},
			},
		});
		expect(res.ok()).toBeTruthy();
		channelId = ((await res.json()) as any).channels[0].id;

		// 注入进站消息
		await page.request.post(`${KERNEL}/api/channels/${channelId}/mock-inbound`, {
			data: { chatId: "u-e2e", text: "你好" },
		});
		// outbox 出现回复（无真实模型 → 错误提示回复，链路通即可）
		await pollUntil(async () => {
			const r = await page.request.get(`${KERNEL}/api/channels/${channelId}/mock-outbox`);
			const body = (await r.json()) as any;
			return body.messages?.length > 0 ? body : null;
		});

		// 侧边栏 IM 页签出现会话，点击打开
		await page.goto("/");
		await page.getByTestId("sidebar-tab-im").click();
		await expect(page.getByTestId("im-conv-list")).toBeVisible({ timeout: 5000 });
		await page.getByText("u-e2e").click();
		await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId("im-source-badge")).toBeVisible();
		await expect(page.getByText("仅显示最近 100 条")).toBeVisible();
	});

	test.afterAll(async ({ request }) => {
		if (channelId) await request.delete(`${KERNEL}/api/channels/${channelId}`);
	});
});
```

（`session-view` 的 testid 以 `SessionView.tsx` 实际根节点为准；若不存在则在实现时补上该 testid。）

- [ ] **Step 3: 跑 E2E**

Run: `cd packages/frontend && bunx playwright test e2e/channels.spec.ts`
Expected: 2 个用例 PASS；失败按 trace 修复（`bunx playwright show-trace`）

- [ ] **Step 4: 清理截图与临时产物**

Run: `rm -rf packages/frontend/test-results .playwright-mcp`（保留 `.last-run.json` 之外的截图/视频/trace 一律删除）
Expected: 工作区无遗留截图

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/e2e/global-setup.ts packages/frontend/e2e/channels.spec.ts
git commit -m "test(e2e): IM 渠道机器人全链路（mock 渠道 + 设置页 + 侧边栏 IM 页签）"
```

---

### Task 15: 真实企微人工联调 + CHANGELOG 收尾

**Files:**
- Modify: `CHANGELOG.md`（顶部加条目）

- [ ] **Step 1: 真实企微联调（人工，逐项勾选）**

前置：企业微信客户端 → 工作台 → 智能机器人 → 创建机器人 → API 模式 → 长连接 → 拿 Bot ID + Secret（[官方文档](https://developer.work.weixin.qq.com/document/path/101463)）。

- 创建渠道：设置页 → 机器人 → 新建 → 企业微信 → 填凭据 → 保存 → 状态变「已连接」
- 单聊文本：发「你好」→ 收到智能体回复（standard 粒度含/不含文件变更符合预期）
- 简洁粒度：改 simple 保存 → 再对话 → 回复仅正文
- 多轮上下文：连续追问 → 上下文连贯（稳定会话）
- `/new` → 回复「已开始新会话」，上下文清空；`/projects`、`/use <项目名>` → 切换生效
- 群聊：拉机器人进群，@机器人 提问 → 正常回复（@前缀已剥离）；不@ 不响应
- 图片：单聊发图片 → 智能体收到附件并回复
- 不支持类型：发语音 → 回复「暂不支持该消息类型」
- 智能体删除：删掉绑定智能体 → 再发消息 → 机器人用默认智能体继续回复
- kernel 重启：渠道自动重连，历史会话可续聊

- [ ] **Step 2: CHANGELOG 收尾**

`CHANGELOG.md` 顶部 `[Unreleased]` 加「新增」条目（仿既有格式：摘要 + 影响范围文件列表）。

- [ ] **Step 3: 全量四层测试最终确认**

Run: `cd packages/shared && bun test && cd ../kernel && bun test && cd ../frontend && bun test --isolate && bunx playwright test`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: IM 渠道机器人 v1 收尾（CHANGELOG + 联调记录）"
```

---

## Self-Review 结论

- **规格覆盖**：§4 架构→Task 6/8；§5 数据模型→Task 1；§6 消息链路→Task 6/8；§7 指令→Task 2/6；§8 提示词注入（含 `$` 技能引用展开）→Task 5 + Task 6A；§9 回复粒度→Task 3/6；§10 智能体删除兜底→Task 6（运行时）+Task 7（引用计数 API）+Task 10（警告条）+Task 12（删除确认提示）；§11 前端（含 `$` 技能自动补全输入框）→Task 9/10/10A/11；§12 API→Task 7/13；§13 错误处理→Task 6/7/8；§14 四层测试→Task 1-6A（单元）、9-12（组件）、13（API）、14（E2E）；§15 风险→Task 15 联调清单。
- **设计补充**（规格外决定，已在头部列出）：渠道 `model` 字段、默认智能体=列表第一项、出站统一 `replyStream` markdown、IM 会话标题用 userid/群 chatId、不做渠道级固定工作目录、`$` 技能引用 kernel 侧内联展开。
- **类型一致性**：`ChannelStatusInfo/ChannelConversationInfo/ChannelInput`、`parseCommand`、`composeReply/chunkByBytes`、`expandSkillTokens`、`ChannelAdapter/InboundMessage/MockAdapter`、`ChannelManager` 方法名、`useChannelsStore` 动作名、`SkillSuggestTextarea` props/testid 已跨任务核对一致。
