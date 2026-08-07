# 企微机器人：默认工作目录 + 切换工作目录开关 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 企微机器人配置新增「默认工作目录」(默认 `__system__`)与「允许切换工作目录」开关(默认关闭)；开关关闭时 IM 侧 `/use`、`/projects` 指令被禁用。

**Architecture:** 数据层给 `ChannelConfig` 扩两个字段，kernel 层在读取时归一化兜底、在新建 IM 会话映射时用渠道默认项目、在指令解析层按开关放行/拒绝；前端表单加一个项目下拉 + 一个 checkbox。`ChannelInput` 是 `Omit<ChannelConfig, "id"|"createdAt">`，自动继承新字段，**前端 store 文件无需改动**。

**Tech Stack:** TypeScript · `@wa-pi/shared`(类型/常量) · `@wa-pi/kernel`(bun:test) · `@wa-pi/frontend`(React + zustand + bun:test + @testing-library/react + happy-dom) · curl 集成脚本 · Playwright E2E

## Global Constraints

- **测试 runner 统一为 `bun:test`**。设计文档第 2 层写的是"Vitest"，但项目实际全栈用 `bun:test`(frontend 用 `bun test --isolate` + happy-dom preload)。RTL 用法不变，只是断言/mock 来自 `bun:test`(`test/expect/mock`，模块 mock 用 `mock.module`，store mock 用 zustand `setState`)。**禁止引入 vitest**。
- 新增的 `defaultProjectId` 缺失时一律回退 `SYSTEM_PROJECT_ID`(常量值 `"__system__"`)，不报错，与读取兜底一致。
- 新增的 `allowProjectSwitch` 缺失时一律视为 `false`(默认不支持切换)。
- 不做 channels.json 迁移写盘，仅在 `loadChannels` 读取时归一化。
- 中文断言文案、中文 commit message(遵循现有约定)。
- 每个任务结束提交一次，commit message 用 `feat`/`fix`/`test`/`refactor`/`docs` 前缀。
- 测试截图(仅 E2E)在测试完成后必须删除，不保留在项目中。

## 设计决策(基于代码现状的权衡)

1. **项目删除兜底放在 `ensureSession`，而非 `handleInbound` 新建映射时。**
   设计文档把"新建映射用 `defaultProjectId`"和"项目删除降级 + warn"列成两条要点。最小改动且 DRY 的落点：新建映射时直接写 `channel.defaultProjectId ?? SYSTEM_PROJECT_ID`(不校验)，真正的存在性校验放 `ensureSession`——那里本来就调用了 `projectStore.load()`(只需把解构从 `{ sessions }` 改成 `{ projects, sessions }`)。这样同时覆盖两种场景：① 渠道默认项目在配置时已失效 ② `allowProjectSwitch=true` 时用户 `/use` 切到某项目后该项目被删。warn 文案与 `resolveAgent` 风格一致。

2. **前端 `channels.ts` 的 `ChannelInput` 无需改动。** 它是 `Omit<ChannelConfig, "id"|"createdAt">`，自动继承新字段。`createBot/updateBot` 的 REST 调用链透传任意字段。只改 `BotsSection.tsx`。

3. **指令开关放 `CommandContext.allowSwitch`，不放在 channel-manager 外层拦截。** 设计文档明确"指令拦截调用 `parseCommand` 时传入 `allowSwitch`"。开关 false 时在 `parseCommand` 内统一处理 `/use`、`/projects` 的拒绝回复和 `/help` 文案裁剪，channel-manager 只负责透传 `channel.allowProjectSwitch ?? false`。

---

## File Structure

| 文件 | 职责 | 操作 |
|---|---|---|
| `packages/shared/src/types.ts` | `ChannelConfig` 类型定义 | Modify(L516-530 加两字段) |
| `packages/kernel/src/channel-store.ts` | 渠道数据读写 + 入参校验 | Modify(loadChannels 归一化、validateChannelInput 兜底) |
| `packages/kernel/tests/channel-store.test.ts` | 渠道存储单测 | Modify(加用例) |
| `packages/kernel/src/channels/commands.ts` | IM 指令解析 | Modify(CommandContext 加 allowSwitch、parseCommand 分支、HELP 文案) |
| `packages/kernel/tests/channel-commands.test.ts` | 指令解析单测 | Modify(加用例) |
| `packages/kernel/src/channel-manager.ts` | IM 会话编排 | Modify(handleInbound 新建映射、parseCommand 调用透传、ensureSession 项目校验) |
| `packages/kernel/tests/channel-manager.test.ts` | 会话编排单测 | Modify(加用例) |
| `packages/frontend/src/components/settings/BotsSection.tsx` | 机器人配置表单 | Modify(emptyDraft、openEdit、表单渲染、import useProjectsStore) |
| `packages/frontend/tests/BotsSection.test.tsx` | 表单组件测试 | Create |
| `scripts/channels-api-it.sh` | curl 集成测试 | Modify(加新字段场景) |
| `packages/frontend/e2e/wecom-bot-default-workdir.spec.ts` | E2E | Create |
| `CHANGELOG.md` | 变更日志 | Modify(顶部加条目) |

---

### Task 1: shared 类型扩展（ChannelConfig 加两个字段）

**Files:**
- Modify: `packages/shared/src/types.ts:516-530`

**Interfaces:**
- Produces: `ChannelConfig.defaultProjectId: string`、`ChannelConfig.allowProjectSwitch: boolean`。后续所有任务消费这两个字段；`ChannelInput`(前端 store)与 `Omit<ChannelConfig,"id"|"createdAt">`(kernel 校验)自动继承。

- [ ] **Step 1: 扩展 ChannelConfig 接口**

在 `packages/shared/src/types.ts` 的 `ChannelConfig` 接口(约 L516-530)中，在 `replyGranularity` 之后、`createdAt` 之前插入两个字段：

```ts
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
	/** 默认工作目录（项目 id），默认 __system__（默认工作区） */
	defaultProjectId: string;
	/** 是否允许 IM 侧切换工作目录（/use、/projects 指令），默认 false */
	allowProjectSwitch: boolean;
	createdAt: number;
}
```

- [ ] **Step 2: 验证 shared 包类型编译通过**

Run: `cd /Users/pipi/work/HiAgent && bun run --filter @wa-pi/shared test`
Expected: PASS（现有 shared 测试全过；纯类型新增不破坏运行时）。

- [ ] **Step 3: 验证 kernel/frontend 类型编译通过（类型联动检查）**

Run: `cd /Users/pipi/work/HiAgent && bunx tsc --noEmit -p packages/kernel/tsconfig.json && bunx tsc --noEmit -p packages/frontend/tsconfig.json`
Expected: 报错集中在"缺少 defaultProjectId/allowProjectSwitch 属性"的构造点(channel-store 测试、BotsSection emptyDraft 等)。这些报错正是后续任务要修复的点；本步只确认类型已正确导出且报错仅限于"待补字段"，不涉及类型本身语法错误。

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): ChannelConfig 新增 defaultProjectId 与 allowProjectSwitch 字段"
```

---

### Task 2: channel-store 读取归一化 + 入参校验兜底

**Files:**
- Modify: `packages/kernel/src/channel-store.ts`（loadChannels L35-40、validateChannelInput L67-77）
- Test: `packages/kernel/tests/channel-store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ChannelConfig` 新字段；`SYSTEM_PROJECT_ID`（`@wa-pi/shared`）
- Produces: `loadChannels` 返回值保证每条 channel 都带 `defaultProjectId`/`allowProjectSwitch`（旧数据兜底）；`validateChannelInput` 对 `defaultProjectId` 缺失回退默认工作区。

- [ ] **Step 1: 写失败测试（channel-store.test.ts）**

在 `packages/kernel/tests/channel-store.test.ts` 顶部 import 区，确认已 import `SYSTEM_PROJECT_ID`；若未 import 则补：

```ts
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";
```

在文件末尾追加三个测试：

```ts
test("loadChannels: 旧数据（无 defaultProjectId/allowProjectSwitch）读取兜底", async () => {
	// 模拟旧版 channels.json：不含新字段
	const file = join(dir, "channels.json");
	await writeFile(
		file,
		JSON.stringify({
			schemaVersion: 1,
			channels: [
				{
					id: "ch_old",
					type: "wecom",
					name: "旧机器人",
					enabled: true,
					credentials: { botId: "b1", secret: "s1" },
					agentName: "前端开发者",
					model: null,
					extraSystemPrompt: "",
					replyGranularity: "simple",
					createdAt: 1,
				},
			],
		}),
		"utf8",
	);
	const list = await loadChannels(file);
	expect(list).toHaveLength(1);
	expect(list[0].defaultProjectId).toBe(SYSTEM_PROJECT_ID);
	expect(list[0].allowProjectSwitch).toBe(false);
});

test("loadChannels: 新数据保留显式配置值", async () => {
	const file = join(dir, "channels.json");
	await writeFile(
		file,
		JSON.stringify({
			schemaVersion: 1,
			channels: [
				{
					id: "ch_new",
					type: "wecom",
					name: "新机器人",
					enabled: true,
					credentials: { botId: "b1", secret: "s1" },
					agentName: "前端开发者",
					model: null,
					extraSystemPrompt: "",
					replyGranularity: "simple",
					defaultProjectId: "proj_x",
					allowProjectSwitch: true,
					createdAt: 1,
				},
			],
		}),
		"utf8",
	);
	const list = await loadChannels(file);
	expect(list[0].defaultProjectId).toBe("proj_x");
	expect(list[0].allowProjectSwitch).toBe(true);
});

test("validateChannelInput: defaultProjectId 缺失时回退默认工作区（不报错）", () => {
	const err = validateChannelInput({
		type: "wecom",
		name: "机器人",
		enabled: true,
		credentials: { botId: "b1", secret: "s1" },
		agentName: "前端开发者",
		model: null,
		extraSystemPrompt: "",
		replyGranularity: "simple",
		// 故意不传 defaultProjectId / allowProjectSwitch
	} as any);
	expect(err).toBeNull();
});
```

> 说明：若该测试文件顶部尚无 `dir` 临时目录 fixture，参考文件已有的 `beforeEach`/`afterEach`（`mkdtemp(join(tmpdir(), "wa-pi-channel-store-test-"))`），确保 `dir` 可用。

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/channel-store.test.ts`
Expected: 三个新测试 FAIL（`defaultProjectId` 为 `undefined`、`allowProjectSwitch` 为 `undefined`、类型断言不通过）。

- [ ] **Step 3: 实现 loadChannels 归一化**

修改 `packages/kernel/src/channel-store.ts` 的 `loadChannels`（L35-40），对每条 channel 做字段兜底：

```ts
export async function loadChannels(
	file: string = CHANNELS_FILE,
): Promise<ChannelConfig[]> {
	const raw = await readJson<{ channels?: ChannelConfig[] }>(file, []);
	const list = Array.isArray(raw.channels) ? raw.channels : [];
	// 旧数据兼容：缺省字段归一化，不写盘
	for (const c of list) {
		if (!c.defaultProjectId) c.defaultProjectId = SYSTEM_PROJECT_ID;
		if (typeof c.allowProjectSwitch !== "boolean") c.allowProjectSwitch = false;
	}
	return list;
}
```

同步在文件顶部 import 区加 `SYSTEM_PROJECT_ID`（若未 import）：

```ts
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";
```

> 注意：`readJson` 第二参数原来是 `{}`，这里改为 `[]`，使 `Array.isArray([])` 成立、兜底返回空数组，行为等价但更清晰。

- [ ] **Step 4: 实现 validateChannelInput 兜底**

修改 `validateChannelInput`（L67-77），在现有校验之后、`return null` 之前加 defaultProjectId 兜底（不报错，与读取兜底一致）：

```ts
export function validateChannelInput(
	input: Omit<ChannelConfig, "id" | "createdAt">,
): string | null {
	if (!input.name?.trim()) return "机器人名称不能为空";
	if (!VALID_TYPES.has(input.type)) return `不支持的渠道类型: ${input.type}`;
	if (!input.credentials?.botId?.trim()) return "Bot ID 不能为空";
	if (!input.credentials?.secret?.trim()) return "Secret 不能为空";
	if (!VALID_GRANULARITY.has(input.replyGranularity))
		return `非法的回复粒度: ${input.replyGranularity}`;
	// defaultProjectId 缺失回退默认工作区（与 loadChannels 读取兜底一致，不报错）
	if (!input.defaultProjectId) input.defaultProjectId = SYSTEM_PROJECT_ID;
	return null;
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/channel-store.test.ts`
Expected: PASS（含三个新测试）。

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/channel-store.ts packages/kernel/tests/channel-store.test.ts
git commit -m "feat(kernel): channel-store 读取归一化 defaultProjectId/allowProjectSwitch + 校验兜底"
```

---

### Task 3: commands.ts 指令开关（CommandContext.allowSwitch）

**Files:**
- Modify: `packages/kernel/src/channels/commands.ts`（CommandContext L3-6、HELP L15-16、parseCommand 分支 L27-50）
- Test: `packages/kernel/tests/channel-commands.test.ts`

**Interfaces:**
- Consumes: 无（本任务为开关逻辑源头）
- Produces: `CommandContext.allowSwitch: boolean`；`parseCommand` 在 `allowSwitch===false` 时对 `/use`、`/projects` 返回拒绝回复，`/help` 文案不含这两条。channel-manager（Task 4）透传 `channel.allowProjectSwitch ?? false` 到此字段。

- [ ] **Step 1: 写失败测试（channel-commands.test.ts）**

在 `packages/kernel/tests/channel-commands.test.ts` 末尾追加用例。先确认文件顶部 import 了 `parseCommand` 与一个示例 projects 列表 fixture（复用文件已有写法）。追加：

```ts
const PROJECTS = [
	{ id: "__system__", name: "默认工作区" },
	{ id: "proj_a", name: "项目A" },
];

test("allowSwitch=false：/use 被拒", () => {
	const r = parseCommand("/use 项目A", {
		projects: PROJECTS,
		currentProjectId: "__system__",
		allowSwitch: false,
	});
	expect(r.handled).toBe(true);
	expect(r.switchProjectId).toBeUndefined();
	expect(r.reply).toContain("不支持切换工作目录");
});

test("allowSwitch=false：/projects 被拒", () => {
	const r = parseCommand("/projects", {
		projects: PROJECTS,
		currentProjectId: "__system__",
		allowSwitch: false,
	});
	expect(r.handled).toBe(true);
	expect(r.reply).toContain("不支持切换工作目录");
});

test("allowSwitch=false：/help 文案不含 /use 和 /projects", () => {
	const r = parseCommand("/help", {
		projects: PROJECTS,
		currentProjectId: "__system__",
		allowSwitch: false,
	});
	expect(r.handled).toBe(true);
	expect(r.reply).not.toContain("/use");
	expect(r.reply).not.toContain("/projects");
	expect(r.reply).toContain("/new");
});

test("allowSwitch=true：/use 行为不变（切换成功）", () => {
	const r = parseCommand("/use 项目A", {
		projects: PROJECTS,
		currentProjectId: "__system__",
		allowSwitch: true,
	});
	expect(r.handled).toBe(true);
	expect(r.switchProjectId).toBe("proj_a");
});

test("allowSwitch=true：/help 含 /use 和 /projects", () => {
	const r = parseCommand("/help", {
		projects: PROJECTS,
		currentProjectId: "__system__",
		allowSwitch: true,
	});
	expect(r.reply).toContain("/use");
	expect(r.reply).toContain("/projects");
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/channel-commands.test.ts`
Expected: 新测试 FAIL（`CommandContext` 无 `allowSwitch` 字段，TS 报错或行为不符）。

- [ ] **Step 3: 实现 CommandContext 扩展 + 开关逻辑**

修改 `packages/kernel/src/channels/commands.ts` 全文如下（在 `CommandContext` 加 `allowSwitch`，拆分 HELP 为含/不含切换两版，parseCommand 前置判断开关）：

```ts
export interface CommandContext {
	projects: { id: string; name: string }[];
	currentProjectId: string;
	/** 是否允许切换工作目录（来自 channel.allowProjectSwitch）；false 时 /use、/projects 被禁用 */
	allowSwitch: boolean;
}

export interface CommandResult {
	handled: boolean;
	reply?: string;
	switchProjectId?: string;
	resetSession?: boolean;
}

const HELP_FULL =
	"可用指令：\n/new 开始新会话\n/projects 列出可用工作区\n/use <工作区名> 切换工作区\n/help 查看帮助";
const HELP_NO_SWITCH =
	"可用指令：\n/new 开始新会话\n/help 查看帮助";
const REJECT_SWITCH = "该机器人不支持切换工作目录。";

export function parseCommand(text: string, ctx: CommandContext): CommandResult {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return { handled: false };
	const [cmd, ...rest] = trimmed.split(/\s+/);
	const arg = rest.join(" ").trim();
	const help = ctx.allowSwitch ? HELP_FULL : HELP_NO_SWITCH;
	const projectList = ctx.projects
		.map((p) => `${p.id === ctx.currentProjectId ? "（当前）" : ""}${p.name}`)
		.join("\n");

	switch (cmd) {
		case "/new":
			return { handled: true, resetSession: true, reply: "已开始新会话。" };
		case "/projects":
			if (!ctx.allowSwitch) return { handled: true, reply: REJECT_SWITCH };
			return { handled: true, reply: `可用工作区：\n${projectList}` };
		case "/use": {
			if (!ctx.allowSwitch) return { handled: true, reply: REJECT_SWITCH };
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
			return { handled: true, reply: help };
		default:
			return { handled: true, reply: `未知指令 ${cmd}。\n${help}` };
	}
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/channel-commands.test.ts`
Expected: PASS（含新测试 + 既有测试）。

> 注意：既有测试若构造 `CommandContext` 时未传 `allowSwitch`，会因新字段必填而 TS 报错。需把既有测试的 ctx 补上 `allowSwitch: true`（保持原行为）。本步骤包含对既有测试的最小补字段改动。

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/channels/commands.ts packages/kernel/tests/channel-commands.test.ts
git commit -m "feat(kernel): IM 指令层支持 allowProjectSwitch 开关，关闭时禁用 /use /projects"
```

---

### Task 4: channel-manager 默认工作区解析 + allowSwitch 透传 + 项目删除兜底

**Files:**
- Modify: `packages/kernel/src/channel-manager.ts`（handleInbound 新建映射 L362-372、parseCommand 调用 L381-384、ensureSession L500-533）
- Test: `packages/kernel/tests/channel-manager.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `channel.defaultProjectId`（已归一化保证存在）；Task 3 的 `CommandContext.allowSwitch`；`SYSTEM_PROJECT_ID`。
- Produces: IM 会话映射初始项目来自渠道配置；`/use`/`/projects` 按渠道开关放行；映射的 `currentProjectId` 失效时降级 `__system__` + warn。

- [ ] **Step 1: 写失败测试（channel-manager.test.ts）**

在 `packages/kernel/tests/channel-manager.test.ts` 中：

**0a. 补 import。** 文件顶部现有 `import { afterEach, beforeEach, expect, test } from "bun:test";`，需补 `mock`：

```ts
import { afterEach, beforeEach, expect, test, mock } from "bun:test";
```

**0b. channel fixture 补字段。** 找到 `channel` fixture 定义处(文件顶部附近，形如 `const channel: ChannelConfig = { ... }`)，给所有现有 channel fixture 补上新字段以适配 Task 1 的类型（若已有补丁则跳过）：

```ts
// 在 channel fixture 中补：
defaultProjectId: "__system__",
allowProjectSwitch: false,
```

在文件末尾追加三个测试：

```ts
test("新建映射使用渠道 defaultProjectId（非默认工作区）", async () => {
	// projectStore mock 需包含 proj_x，确保 ensureSession 校验通过
	const channelCustom: ChannelConfig = {
		...channel,
		id: "ch_custom",
		defaultProjectId: "proj_x",
		allowProjectSwitch: false,
	};
	await manager.create(channelCustom);
	adapter!.inject({ chatId: "u_custom", text: "你好" });
	await new Promise((r) => setTimeout(r, 50));
	expect(sessionsCreated).toHaveLength(1);
	expect(sessionsCreated[0].projectId).toBe("proj_x");
});

test("allowProjectSwitch=false：/use 被拒，不切换", async () => {
	await manager.create(channel); // channel.allowProjectSwitch=false
	adapter!.inject({ chatId: "u_noswitch", text: "你好" });
	await new Promise((r) => setTimeout(r, 50));
	// 记下当前 projectId
	const beforeProject = sessionsCreated[0].projectId;
	adapter!.inject({ chatId: "u_noswitch", text: "/use 项目A" });
	await new Promise((r) => setTimeout(r, 50));
	// /use 被拒后不应新建会话、不应切换；prompted 末尾应含拒绝回复
	expect(prompted.length).toBeGreaterThanOrEqual(1);
	// 拒绝回复经由 reply 通道（mock 中 reply 进 prompted）；断言文案
	const last = prompted[prompted.length - 1];
	expect(last.text).toContain("不支持切换工作目录");
});

test("defaultProjectId 指向已删除项目时，ensureSession 降级为 __system__ 并 warn", async () => {
	const warnSpy = mock(() => {});
	const origWarn = console.warn;
	console.warn = warnSpy;
	try {
		const channelDead: ChannelConfig = {
			...channel,
			id: "ch_dead",
			defaultProjectId: "proj_deleted", // 不在 projectStore mock 的 projects 里
		};
		await manager.create(channelDead);
		adapter!.inject({ chatId: "u_dead", text: "你好" });
		await new Promise((r) => setTimeout(r, 50));
		expect(sessionsCreated).toHaveLength(1);
		expect(sessionsCreated[0].projectId).toBe("__system__");
		expect(warnSpy).toHaveBeenCalled();
	} finally {
		console.warn = origWarn;
	}
});
```

> 说明：`projectStore` 的 mock（`beforeEach` 内）需确保 `load()` 返回的 `projects` 含 `__system__`、`proj_x`，但**不含** `proj_deleted`。若现有 mock 只列了 `__system__`，需补 `proj_x`：
> ```ts
> projectStore: {
>   load: async () => ({
>     projects: [
>       { id: "__system__", name: "默认工作区", cwd: "/tmp/sys", createdAt: 1 },
>       { id: "proj_x", name: "项目X", cwd: "/tmp/x", createdAt: 2 },
>     ],
>     sessions: projectSessions,
>   }),
>   ...
> }
> ```
> 保持 `proj_deleted` 故意缺席以触发降级路径。

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/channel-manager.test.ts`
Expected: 新测试 FAIL（新建映射仍用 `SYSTEM_PROJECT_ID`；`/use` 未被拒；删除项目未降级）。

- [ ] **Step 3: 实现 handleInbound 新建映射用 defaultProjectId**

修改 `packages/kernel/src/channel-manager.ts` 的 `handleInbound`，新建映射处（L362-372）把硬编码 `SYSTEM_PROJECT_ID` 改为渠道默认（**不在此处校验存在性，交给 ensureSession 兜底**）：

```ts
if (!mapping) {
	mapping = {
		channelId: channel.id,
		chatId: msg.chatId,
		chatType: msg.chatType,
		currentProjectId: channel.defaultProjectId ?? SYSTEM_PROJECT_ID,
		sessions: {},
		lastMessagePreview: "",
		updatedAt: Date.now(),
	};
	mappings.push(mapping);
}
```

- [ ] **Step 4: 实现 parseCommand 调用透传 allowSwitch**

修改 `handleInbound` 的指令拦截段（L381-384），`CommandContext` 增加 `allowSwitch`：

```ts
const cmd = parseCommand(msg.text, {
	projects: projects.map((p) => ({ id: p.id, name: p.name })),
	currentProjectId: mapping.currentProjectId,
	allowSwitch: channel.allowProjectSwitch ?? false,
});
```

- [ ] **Step 5: 实现 ensureSession 项目删除兜底**

修改 `ensureSession`（L500-533）。把首个 `projectStore.load()` 的解构从 `{ sessions }` 改为 `{ projects, sessions }`，在缓存校验之前加 projectId 存在性校验：

```ts
private async ensureSession(
	mapping: ChannelSessionMapping,
	agent: AgentConfig,
): Promise<string> {
	const { projects, sessions } = await this.deps.projectStore.load();

	// 项目删除兜底：currentProjectId 指向已删除项目时降级为默认工作区
	if (!projects.some((p) => p.id === mapping.currentProjectId)) {
		console.warn(
			`[channel-manager] IM 映射 currentProjectId=${mapping.currentProjectId} 对应项目已删除，降级为默认工作区`,
		);
		mapping.currentProjectId = SYSTEM_PROJECT_ID;
	}

	const existing = mapping.sessions[mapping.currentProjectId];
	if (existing) {
		if (sessions.some((s) => s.id === existing)) {
			return existing;
		}
		delete mapping.sessions[mapping.currentProjectId];
		console.warn(
			`[channel-manager] IM 映射缓存的会话 ${existing} 已失效（project-store 中不存在），兜底新建会话`,
		);
	}
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
	this.deps.broadcast({ type: "session:created", session });
	return session.id;
}
```

> 注意：原 `ensureSession` 在缓存命中分支里调用了 `projectStore.load()` 只为校验 session。现在 load 提到最前，缓存分支复用同一份 `sessions`，行为等价但少一次 load。

- [ ] **Step 6: 运行测试验证通过**

Run: `cd /Users/pipi/work/HiAgent/packages/kernel && bun test tests/channel-manager.test.ts`
Expected: PASS（含三个新测试 + 既有测试）。

- [ ] **Step 7: 运行 kernel 全量测试确认无回归**

Run: `cd /Users/pipi/work/HiAgent/packages/kernel && bun test`
Expected: PASS（全量绿）。

- [ ] **Step 8: Commit**

```bash
git add packages/kernel/src/channel-manager.ts packages/kernel/tests/channel-manager.test.ts
git commit -m "feat(kernel): IM 会话映射使用渠道默认工作区 + allowProjectSwitch 透传 + 项目删除降级"
```

---

### Task 5: 前端 BotsSection 表单（默认工作目录下拉 + 允许切换 checkbox）

**Files:**
- Modify: `packages/frontend/src/components/settings/BotsSection.tsx`（emptyDraft L22-30、openEdit L56-65、表单渲染区 L153+、import 区）
- Create: `packages/frontend/tests/BotsSection.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `ChannelConfig` 新字段（经 `ChannelInput` 自动继承）；`useProjectsStore`（`packages/frontend/src/store/projects.ts`，提供 `projects: ProjectEntity[]`）。
- Produces: 表单新增「默认工作目录」select（`data-testid="bot-default-project-select"`）与「允许切换工作目录」checkbox（`data-testid="bot-allow-switch-toggle"`）；`emptyDraft`/`openEdit` 同步两字段。

- [ ] **Step 1: 写失败测试（BotsSection.test.tsx 新建）**

创建 `packages/frontend/tests/BotsSection.test.tsx`：

```tsx
import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useChannelsStore } from "../src/store/channels";
import { useProjectsStore } from "../src/store/projects";
import { useAgentsStore } from "../src/store/agents";
import { useProvidersStore } from "../src/store/providers";
import { useToastStore } from "../src/store/toast";

// mock api-client（避免 happy-dom about:blank 相对 URL 报错）
const apiCalls: { method: string; path: string; body?: any }[] = [];
mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) =>
			path.includes("/agents")
				? Promise.resolve({ agents: [{ displayName: "前端开发者", model: "p/m" }] })
				: path.includes("/channels")
				? Promise.resolve({ channels: [] })
				: Promise.resolve(null),
		post: (path: string, body: any) => {
			apiCalls.push({ method: "post", path, body });
			return Promise.resolve({ channels: [] });
		},
		put: (path: string, body: any) => {
			apiCalls.push({ method: "put", path, body });
			return Promise.resolve({ channels: [] });
		},
		del: () => Promise.resolve({ channels: [] }),
	},
}));

import { BotsSection } from "../src/components/settings/BotsSection";

beforeEach(() => {
	useChannelsStore.setState(useChannelsStore.getInitialState(), true);
	useProjectsStore.setState(useProjectsStore.getInitialState(), true);
	useAgentsStore.setState(useAgentsStore.getInitialState(), true);
	useProvidersStore.setState(useProvidersStore.getInitialState(), true);
	useToastStore.setState(useToastStore.getInitialState(), true);
	apiCalls.length = 0;
});

test("新建表单：默认工作目录默认选中「默认工作区」，允许切换默认不勾", () => {
	useProjectsStore.setState({
		projects: [
			{ id: "__system__", name: "默认工作区", cwd: "/tmp/sys", createdAt: 1 },
			{ id: "proj_a", name: "项目A", cwd: "/tmp/a", createdAt: 2 },
		],
	} as any);
	useAgentsStore.setState({ agents: [{ displayName: "前端开发者", model: "p/m" }] as any });

	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bot-add-btn"));

	expect((screen.getByTestId("bot-default-project-select") as HTMLSelectElement).value).toBe(
		"__system__",
	);
	expect(
		(screen.getByTestId("bot-allow-switch-toggle") as HTMLInputElement).checked,
	).toBe(false);
	// 下拉包含默认工作区与项目A
	expect(
		screen.getByTestId("bot-default-project-select").textContent,
	).toContain("默认工作区");
	expect(
		screen.getByTestId("bot-default-project-select").textContent,
	).toContain("项目A");
});

test("保存新建：提交体含 defaultProjectId 与 allowProjectSwitch", async () => {
	useProjectsStore.setState({
		projects: [{ id: "__system__", name: "默认工作区", cwd: "/tmp/sys", createdAt: 1 }],
	} as any);
	useAgentsStore.setState({ agents: [{ displayName: "前端开发者", model: "p/m" }] as any });

	render(<BotsSection />);
	fireEvent.click(screen.getByTestId("bot-add-btn"));
	// 填必填项
	fireEvent.change(screen.getByTestId("bot-name-input"), { target: { value: "机器人1" } });
	fireEvent.change(screen.getByTestId("bot-id-input"), { target: { value: "bid" } });
	fireEvent.change(screen.getByTestId("bot-secret-input"), { target: { value: "sec" } });
	// 勾选允许切换
	fireEvent.click(screen.getByTestId("bot-allow-switch-toggle"));
	// 切换默认工作目录到项目A（若有）。此处仅默认工作区，保持 __system__
	fireEvent.click(screen.getByTestId("bot-save-btn"));

	await waitFor(() => expect(apiCalls.length).toBe(1));
	expect(apiCalls[0].method).toBe("post");
	expect(apiCalls[0].body.channel.defaultProjectId).toBe("__system__");
	expect(apiCalls[0].body.channel.allowProjectSwitch).toBe(true);
});

test("编辑回填：已有机器人字段正确回显", async () => {
	useProjectsStore.setState({
		projects: [
			{ id: "__system__", name: "默认工作区", cwd: "/tmp/sys", createdAt: 1 },
			{ id: "proj_a", name: "项目A", cwd: "/tmp/a", createdAt: 2 },
		],
	} as any);
	useChannelsStore.setState({
		bots: [
			{
				id: "ch_1",
				type: "wecom",
				name: "已有机器人",
				enabled: true,
				credentials: { botId: "bid", secret: "****1234" },
				agentName: "前端开发者",
				model: null,
				extraSystemPrompt: "",
				replyGranularity: "standard",
				defaultProjectId: "proj_a",
				allowProjectSwitch: true,
				createdAt: 1,
			},
		],
	} as any);
	useAgentsStore.setState({ agents: [{ displayName: "前端开发者", model: "p/m" }] as any });

	render(<BotsSection />);
	await waitFor(() => expect(screen.getByText("已有机器人")).toBeTruthy());
	fireEvent.click(screen.getByText("已有机器人"));

	expect((screen.getByTestId("bot-default-project-select") as HTMLSelectElement).value).toBe(
		"proj_a",
	);
	expect(
		(screen.getByTestId("bot-allow-switch-toggle") as HTMLInputElement).checked,
	).toBe(true);
});
```

> 说明：测试中用到的 `data-testid`（如 `bot-add-btn`、`bot-id-input`、`bot-secret-input`、`bot-save-btn`）若与现有 BotsSection 实际 testid 不一致，以现有代码为准——可在 Step 3 实现时统一补齐 testid。本测试要求新增控件必须带 `bot-default-project-select` 与 `bot-allow-switch-toggle`。

- [ ] **Step 2: 运行测试验证失败**

Run: `cd /Users/pipi/work/HiAgent/packages/frontend && bun test --isolate tests/BotsSection.test.tsx`
Expected: FAIL（找不到 `bot-default-project-select` / `bot-allow-switch-toggle`）。

- [ ] **Step 3: 实现 BotsSection 表单**

修改 `packages/frontend/src/components/settings/BotsSection.tsx`：

**3a. import useProjectsStore**（文件顶部 import 区）：

```tsx
import { useProjectsStore } from "../../store/projects";
```

**3b. 组件内取 projects 列表**（在 `BotsSection` 组件函数体内，与其他 store 取值并列）：

```tsx
const projects = useProjectsStore((s) => s.projects);
```

**3c. 扩展 emptyDraft（L22-30）**：

```tsx
function emptyDraft(type: ChannelType): ChannelInput {
	return {
		type, name: "", enabled: true,
		credentials: { botId: "", secret: "" },
		agentName: "", model: null,
		extraSystemPrompt: "", replyGranularity: "standard",
		defaultProjectId: "__system__", allowProjectSwitch: false,
	};
}
```

**3d. 扩展 openEdit（L56-65）**：

```tsx
const openEdit = (id: string) => {
	const b = bots.find((x) => x.id === id)!;
	setSelectedId(id);
	setDraft({
		type: b.type, name: b.name, enabled: b.enabled,
		credentials: { botId: b.credentials.botId, secret: "" },
		agentName: b.agentName, model: b.model,
		extraSystemPrompt: b.extraSystemPrompt, replyGranularity: b.replyGranularity,
		defaultProjectId: b.defaultProjectId ?? "__system__",
		allowProjectSwitch: b.allowProjectSwitch ?? false,
	});
};
```

**3e. 表单渲染区加两个控件**（放在现有「回复粒度」select 之后、「启用」checkbox 之前，沿用现有 label/className 模式）：

```tsx
<label className="flex flex-col gap-1 w-72">
	<span className="text-xs text-secondary">默认工作目录</span>
	<select value={draft.defaultProjectId}
		onChange={(e) => setDraft({ ...draft, defaultProjectId: e.target.value })}
		className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
		data-testid="bot-default-project-select">
		{projects.map((p) => (
			<option key={p.id} value={p.id}>{p.name}</option>
		))}
	</select>
	<span className="text-xs text-tertiary">IM 会话默认落在该工作区。</span>
</label>

<label className="flex items-center gap-2 text-sm text-secondary">
	<input type="checkbox" checked={draft.allowProjectSwitch}
		onChange={(e) => setDraft({ ...draft, allowProjectSwitch: e.target.checked })}
		data-testid="bot-allow-switch-toggle" />
	允许切换工作目录
</label>
<span className="text-xs text-tertiary -mt-1">开启后 IM 侧可通过 /use、/projects 指令查看并切换工作区。</span>
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd /Users/pipi/work/HiAgent/packages/frontend && bun test --isolate tests/BotsSection.test.tsx`
Expected: PASS。

> 若失败且报 testid 不匹配，对照现有 BotsSection 的 add/save/id/secret 按钮 testid 修正测试，或补齐组件 testid（保持与现有命名风格一致）。

- [ ] **Step 5: 运行前端全量组件测试确认无回归**

Run: `cd /Users/pipi/work/HiAgent/packages/frontend && bun test --isolate`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/components/settings/BotsSection.tsx packages/frontend/tests/BotsSection.test.tsx
git commit -m "feat(frontend): 机器人配置表单新增默认工作目录下拉与允许切换开关"
```

---

### Task 6: curl API 集成测试

**Files:**
- Modify: `scripts/channels-api-it.sh`（在现有 9 场景基础上加新字段场景）

**Interfaces:**
- Consumes: Task 1-4 已完成的 API 读写链路。
- Produces: 验证创建/更新机器人携带新字段 → GET 返回一致；缺省字段 → 返回兜底值。

- [ ] **Step 1: 在 channels-api-it.sh 加新字段断言**

在 `scripts/channels-api-it.sh` 中找到"200 创建"步骤（提取 id 后、下一步之前），把创建 body 加上新字段并新增断言。定位现有创建用例里构造 channel body 的位置，扩展为：

```bash
# 200 创建（携带新字段）
CODE=$(curl -s -o /tmp/ch-res.json -w "%{http_code}" -X POST "$BASE/api/channels" \
	-H "Content-Type: application/json" \
	-d '{"channel":{"type":"mock","name":"默认机器人","enabled":true,"credentials":{"botId":"bot_default","secret":"sec1234"},"agentName":"前端开发者","model":null,"extraSystemPrompt":"","replyGranularity":"simple","defaultProjectId":"__system__","allowProjectSwitch":false}}')
[ "$CODE" = "200" ] || fail "创建应返回 200，实际 $CODE"
CH_ID=$(grep -o '"id":"ch_[^"]*"' /tmp/ch-res.json | head -1 | cut -d'"' -f4)
grep -q '"defaultProjectId":"__system__"' /tmp/ch-res.json || fail "创建响应应回显 defaultProjectId=__system__"
grep -q '"allowProjectSwitch":false' /tmp/ch-res.json || fail "创建响应应回显 allowProjectSwitch=false"

# 缺省字段兜底（旧客户端风格）
CODE=$(curl -s -o /tmp/ch-res2.json -w "%{http_code}" -X POST "$BASE/api/channels" \
	-H "Content-Type: application/json" \
	-d '{"channel":{"type":"mock","name":"兜底机器人","enabled":true,"credentials":{"botId":"bot_fb","secret":"sec1234"},"agentName":"前端开发者","model":null,"extraSystemPrompt":"","replyGranularity":"simple"}}')
[ "$CODE" = "200" ] || fail "缺省字段创建应返回 200，实际 $CODE"
grep -q '"defaultProjectId":"__system__"' /tmp/ch-res2.json || fail "缺省时应兜底 defaultProjectId=__system__"
grep -q '"allowProjectSwitch":false' /tmp/ch-res2.json || fail "缺省时应兜底 allowProjectSwitch=false"

# 更新：开启允许切换 + 改默认工作目录
CODE=$(curl -s -o /tmp/ch-res3.json -w "%{http_code}" -X PUT "$BASE/api/channels/$CH_ID" \
	-H "Content-Type: application/json" \
	-d '{"channel":{"defaultProjectId":"proj_e2e","allowProjectSwitch":true}}')
[ "$CODE" = "200" ] || fail "更新应返回 200，实际 $CODE"
grep -q '"defaultProjectId":"proj_e2e"' /tmp/ch-res3.json || fail "更新响应应回显 defaultProjectId=proj_e2e"
grep -q '"allowProjectSwitch":true' /tmp/ch-res3.json || fail "更新响应应回显 allowProjectSwitch=true"
```

> 说明：`proj_e2e` 需在测试 kernel 启动前存在于 projects.json，否则 update 后 GET 仍回显原值（兜底在 load 层、不在 save 层强制写盘）。若隔离 kernel 默认无该项目，可把此断言改为更新 `allowProjectSwitch:true` 与 `defaultProjectId:__system__`（一定存在）。

- [ ] **Step 2: 运行集成测试**

```bash
# 启动隔离 kernel
WA_PI_CHANNELS_MOCK=1 WA_PI_DIR=$(mktemp -d) bun run --filter @wa-pi/kernel dev &
KERNEL_PID=$!
sleep 3
# 跑集成脚本
bash scripts/channels-api-it.sh http://localhost:9776
RC=$?
kill $KERNEL_PID
exit $RC
```

Expected: 脚本打印 ✅ 全过（含新断言）。清理临时 WA_PI_DIR。

- [ ] **Step 3: Commit**

```bash
git add scripts/channels-api-it.sh
git commit -m "test(channels): API 集成脚本覆盖 defaultProjectId/allowProjectSwitch"
```

---

### Task 7: Playwright E2E

**Files:**
- Create: `packages/frontend/e2e/wecom-bot-default-workdir.spec.ts`

**Interfaces:**
- Consumes: Task 1-5 完成的完整链路；E2E helpers（`./helpers`，参考 `settings-provider.spec.ts`）。

- [ ] **Step 1: 新建 E2E spec**

创建 `packages/frontend/e2e/wecom-bot-default-workdir.spec.ts`（参考 `e2e/settings-provider.spec.ts` 的结构：`test.describe.serial`、共享隔离 kernel、用 `page.getByTestId`、自我清理）：

```ts
import { test, expect } from "@playwright/test";

test.describe.serial("企微机器人：默认工作目录 + 切换开关", () => {
	const botName = "e2e-default-workdir-bot";

	test.afterAll(async () => {
		// 自我清理：删除本 spec 创建的机器人（避免污染共享 kernel）
		const res = await fetch(
			`${process.env.E2E_API_BASE ?? "http://localhost:9776"}/api/channels`,
		);
		const body = await res.json();
		const bot = (body.channels ?? []).find((c: any) => c.name === botName);
		if (bot) {
			await fetch(`${process.env.E2E_API_BASE ?? "http://localhost:9776"}/api/channels/${bot.id}`, {
				method: "DELETE",
			});
		}
	});

	test("配置默认工作目录与允许切换开关并保存", async ({ page }) => {
		await page.goto("/");
		await page.getByTestId("settings-btn").click();
		await page.getByText("机器人").click();

		// 新建
		await page.getByTestId("bot-add-btn").click();
		await page.getByTestId("bot-name-input").fill(botName);
		await page.getByTestId("bot-id-input").fill("e2e-bot-id");
		await page.getByTestId("bot-secret-input").fill("e2e-secret");

		// 默认工作目录下拉存在且默认为「默认工作区」
		const select = page.getByTestId("bot-default-project-select");
		await expect(select).toBeVisible();
		// 勾选允许切换
		await page.getByTestId("bot-allow-switch-toggle").check();

		await page.getByTestId("bot-save-btn").click();

		// 列表中出现该机器人
		await expect(page.getByText(botName)).toBeVisible();

		// 点开编辑回填校验
		await page.getByText(botName).click();
		await expect(page.getByTestId("bot-allow-switch-toggle")).toBeChecked();
	});
});
```

> 说明：E2E 跑在隔离 kernel（globalSetup 启动）。`bot-add-btn`/`bot-save-btn` 等 testid 以 BotsSection 实际为准（Task 5 已统一）。若 mock 渠道无法在浏览器内触发真实进站，本 spec 聚焦"配置 UI + 保存 + 回填"链路；`/use` 被拒的端到端验证由 Task 6 的 curl + mock 进站覆盖（mock 进站→outbox 已在 channels-api-it.sh 模板中）。

- [ ] **Step 2: 运行 E2E**

Run: `cd /Users/pipi/work/HiAgent && bun run --filter @wa-pi/frontend e2e -- --grep "默认工作目录"`
Expected: PASS。失败截图在 `packages/frontend/e2e/` 或 playwright-output 下，**测试完成后删除截图文件**。

- [ ] **Step 3: 清理截图**

```bash
find packages/frontend -name "*.png" -path "*playwright*" -delete 2>/dev/null || true
find packages/frontend/e2e -name "*screenshot*" -delete 2>/dev/null || true
```

- [ ] **Step 4: Commit**

```bash
git add packages/frontend/e2e/wecom-bot-default-workdir.spec.ts
git commit -m "test(e2e): 企微机器人默认工作目录与切换开关 UI 链路"
```

---

### Task 8: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`（顶部加条目）

- [ ] **Step 1: 在 CHANGELOG.md 顶部（`---` 分隔线后、最新日期之前）插入条目**

若顶部已有 `## 2026-08-07`，则在该日期段下新增 `### 新增` 子段；否则新建 `## 2026-08-07`：

```markdown
## 2026-08-07

### 新增

- **企微机器人默认工作目录 + 切换工作目录开关**：机器人配置新增「默认工作目录」(默认 `__system__`)与「允许切换工作目录」开关(默认关闭)。
  - 动机：原所有 IM 会话硬性落在默认工作区，且 `/use`、`/projects` 对所有机器人无条件开放。
  - 改动：
    - `ChannelConfig` 新增 `defaultProjectId`、`allowProjectSwitch` 字段。
    - `loadChannels` 读取旧数据归一化兜底；`validateChannelInput` 对缺失 `defaultProjectId` 回退默认工作区。
    - `channel-manager` 新建 IM 映射时使用渠道默认工作区；`ensureSession` 对失效 projectId 降级为默认工作区并 warn。
    - `commands.ts` 新增 `CommandContext.allowSwitch`，关闭时 `/use`、`/projects` 返回拒绝回复，`/help` 文案不含这两条。
    - 前端 `BotsSection` 表单新增项目下拉与 checkbox。
  - 兼容：旧 `channels.json` 无需迁移，读取时兜底。
  - 影响范围：`packages/shared/src/types.ts`、`packages/kernel/src/channel-store.ts`、`packages/kernel/src/channel-manager.ts`、`packages/kernel/src/channels/commands.ts`、`packages/frontend/src/components/settings/BotsSection.tsx`、对应测试文件、`scripts/channels-api-it.sh`、`packages/frontend/e2e/wecom-bot-default-workdir.spec.ts`。
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录企微机器人默认工作目录与切换开关"
```

---

## 完成判据

- 四层测试全部通过：kernel 单元测试(bun test)、前端组件测试(bun test --isolate)、curl 集成脚本、Playwright E2E。
- `tsc --noEmit` 对 kernel 与 frontend 项目均无错误。
- CHANGELOG 已更新。
- E2E 截图已清理。
