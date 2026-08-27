import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureScheduledTasksAssets } from "../src/scheduler-assets";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wa-pi-assets-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ensureScheduledTasksAssets", () => {
	test("首次调用创建目录结构 + CLI + README", async () => {
		await ensureScheduledTasksAssets(dir);
		expect(existsSync(join(dir, "tasks"))).toBe(true);
		expect(existsSync(join(dir, "logs"))).toBe(true);
		const cli = readFileSync(join(dir, "cron-task.ts"), "utf8");
		expect(cli).toContain("wa-pi-cron-task-asset v");
		expect(existsSync(join(dir, "README.md"))).toBe(true);
	});

	test("已是最新版 → 不覆盖（用户可能在 README 旁加了笔记文件，不动它们）", async () => {
		await ensureScheduledTasksAssets(dir);
		const note = join(dir, "NOTE.md");
		writeFileSync(note, "我的笔记");
		await ensureScheduledTasksAssets(dir);
		expect(readFileSync(note, "utf8")).toBe("我的笔记");
	});

	test("旧版本戳 → 覆盖升级 CLI 与 README", async () => {
		await ensureScheduledTasksAssets(dir);
		const cliPath = join(dir, "cron-task.ts");
		writeFileSync(cliPath, "// wa-pi-cron-task-asset v0\n旧内容");
		await ensureScheduledTasksAssets(dir);
		expect(readFileSync(cliPath, "utf8")).not.toContain("旧内容");
	});
});

describe("cron-task.ts CLI", () => {
	// CLI 用脚本所在目录为 BASE_DIR（kernel 分发到哪以哪为根），shim 环境下 run 需 BUN_BE_BUN=1
	const CLI_ENV = { ...process.env, BUN_BE_BUN: "1" };

	test("help / add / list / validate / test 全链路", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, "cron-task.ts");
		const run = (args: string[]) =>
			Bun.spawnSync([process.execPath, cli, ...args], {
				cwd: dir,
				env: CLI_ENV,
			});
		expect(run(["help"]).exitCode).toBe(0);

		const add = run([
			"add",
			"--name",
			"每日站会",
			"--agent",
			"main",
			"--schedule",
			'{"type":"daily","time":"09:30"}',
			"--prompt",
			"提醒站会",
		]);
		expect(add.exitCode).toBe(0);
		expect(existsSync(join(dir, "tasks", "每日站会.md"))).toBe(true);

		const list = run(["list"]);
		expect(list.stdout.toString()).toContain("每日站会");
		// add 未指定 --project，projectId 默认 __system__ → list 显示「默认工作区」
		expect(list.stdout.toString()).toContain("[默认工作区]");

		expect(run(["validate", "每日站会"]).exitCode).toBe(0);
		const testOut = run(["test", "每日站会"]);
		expect(testOut.exitCode).toBe(0);
		expect(testOut.stdout.toString()).toContain("09:30");

		// 非法文件校验失败：exitCode 1 + 中文错误
		writeFileSync(join(dir, "tasks", "坏.md"), "没有 frontmatter");
		const bad = run(["validate", "坏"]);
		expect(bad.exitCode).toBe(1);
		expect(bad.stderr.toString() + bad.stdout.toString()).toContain(
			"frontmatter",
		);
	});

	test("run 在 kernel 不在线时明确报错", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, "cron-task.ts");
		// WA_PI_DIR 指向 no-kernel（无 kernel.json）
		const r = Bun.spawnSync([process.execPath, cli, "run", "任意"], {
			cwd: dir,
			env: { ...CLI_ENV, WA_PI_DIR: join(dir, "no-kernel") },
		});
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString() + r.stdout.toString()).toContain("kernel");
	});

	// 路径穿越：id 含 ../ 必须拒绝，不能写出 tasks/ 目录外
	test("任务 id 路径穿越被拒绝", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, "cron-task.ts");
		const r = Bun.spawnSync(
			[process.execPath, cli, "set", "../escape/out", "name", "X"],
			{ cwd: dir, env: CLI_ENV },
		);
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString() + r.stdout.toString()).toContain("id 非法");
		expect(existsSync(join(dir, "escape"))).toBe(false);
	});

	// cron 步进 */0 必须报错而非死循环（与 shared parseField 同规则）
	test("cron 步进 */0 报错退出（不死循环）", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, "cron-task.ts");
		writeFileSync(
			join(dir, "tasks", "零步.md"),
			'---\nname: "零步"\nschedule: {"type":"custom","time":"00:00","cronExpression":"*/0 * * * *"}\nagentId: "main"\nprojectId: "__system__"\nenabled: true\n---\n\n测试\n',
		);
		const r = Bun.spawnSync([process.execPath, cli, "test", "零步"], {
			cwd: dir,
			env: CLI_ENV,
		});
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString() + r.stdout.toString()).toContain("步进");
	});

	// 项目隔离：agent 场景（WA_PI_SCHEDULER_PROJECT_ID 非空）下，set 只能改本项目任务；show 可读所有
	test("agent 场景 set 其他项目任务被拒（隔离），show 可读", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, "cron-task.ts");
		// 写两个任务：pa 归属 + pb 归属
		writeFileSync(
			join(dir, "tasks", "本.md"),
			'---\nname: "本"\nschedule: {"type":"daily","time":"09:00"}\nagentId: "a"\nprojectId: "pa"\nenabled: true\n---\n\nx\n',
		);
		writeFileSync(
			join(dir, "tasks", "别.md"),
			'---\nname: "别"\nschedule: {"type":"daily","time":"09:00"}\nagentId: "a"\nprojectId: "pb"\nenabled: true\n---\n\nx\n',
		);
		// agent 场景：PROJECT_SCOPE=pa
		const agentEnv = { ...CLI_ENV, WA_PI_SCHEDULER_PROJECT_ID: "pa" };
		// set 其他项目（pb）任务 → 拒绝
		const setOther = Bun.spawnSync(
			[process.execPath, cli, "set", "别", "name", "Y"],
			{
				cwd: dir,
				env: agentEnv,
			},
		);
		expect(setOther.exitCode).toBe(1);
		expect(setOther.stderr.toString() + setOther.stdout.toString()).toContain(
			"不属于当前项目",
		);
		// set 本项目（pa）任务 → 允许
		const setOwn = Bun.spawnSync(
			[process.execPath, cli, "set", "本", "name", "Y"],
			{
				cwd: dir,
				env: agentEnv,
			},
		);
		expect(setOwn.exitCode).toBe(0);
		// show 其他项目任务 → 允许读取
		const showOther = Bun.spawnSync([process.execPath, cli, "show", "别"], {
			cwd: dir,
			env: agentEnv,
		});
		expect(showOther.exitCode).toBe(0);
	});

	// delete 隔离：agent 场景只能删本项目任务，删其他项目被拒且明确告知agent
	test("agent 场景 delete 其他项目任务被拒（明确提示），delete 本项目成功", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, "cron-task.ts");
		writeFileSync(
			join(dir, "tasks", "本d.md"),
			'---\nname: "本d"\nschedule: {"type":"daily","time":"09:00"}\nagentId: "a"\nprojectId: "pa"\nenabled: true\n---\n\nx\n',
		);
		writeFileSync(
			join(dir, "tasks", "别d.md"),
			'---\nname: "别d"\nschedule: {"type":"daily","time":"09:00"}\nagentId: "a"\nprojectId: "pb"\nenabled: true\n---\n\nx\n',
		);
		const agentEnv = { ...CLI_ENV, WA_PI_SCHEDULER_PROJECT_ID: "pa" };
		// delete 其他项目（pb）任务 → 拒绝，且提示不可删除其他项目任务
		const delOther = Bun.spawnSync([process.execPath, cli, "delete", "别d"], {
			cwd: dir,
			env: agentEnv,
		});
		expect(delOther.exitCode).toBe(1);
		const delOtherMsg = delOther.stderr.toString() + delOther.stdout.toString();
		expect(delOtherMsg).toContain("不属于当前项目");
		expect(delOtherMsg).toContain("不可以");
		expect(existsSync(join(dir, "tasks", "别d.md"))).toBe(true); // 未删除
		// delete 本项目（pa）任务 → 成功
		const delOwn = Bun.spawnSync([process.execPath, cli, "delete", "本d"], {
			cwd: dir,
			env: agentEnv,
		});
		expect(delOwn.exitCode).toBe(0);
		expect(existsSync(join(dir, "tasks", "本d.md"))).toBe(false);
	});

	// schedule.type 枚举校验（与 shared validateTaskData 同规则）
	test("schedule.type 非法时 validate 失败", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, "cron-task.ts");
		writeFileSync(
			join(dir, "tasks", "年.md"),
			'---\nname: "年"\nschedule: {"type":"yearly","time":"09:30"}\nagentId: "main"\nprojectId: "__system__"\nenabled: true\n---\n\n提示\n',
		);
		const r = Bun.spawnSync([process.execPath, cli, "validate", "年"], {
			cwd: dir,
			env: CLI_ENV,
		});
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString() + r.stdout.toString()).toContain("schedule.type");
	});

	// add --im-push：把 @im-push-to(ch_xx,ct_xxx) 标记注入 prompt，执行时可注册 im_push_to 工具推送
	test("add --im-push 注入推送标记到 prompt（可重复、去重）", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, "cron-task.ts");
		const r = Bun.spawnSync(
			[
				process.execPath,
				cli,
				"add",
				"--name",
				"推送任务",
				"--agent",
				"a",
				"--schedule",
				'{"type":"daily","time":"09:00"}',
				"--im-push",
				"ch_企微,ct_111",
				"--im-push",
				"ch_企微,ct_222",
				"--prompt",
				"每天早上汇报",
			],
			{ cwd: dir, env: CLI_ENV },
		);
		expect(r.exitCode).toBe(0);
		const prompt = readFileSync(join(dir, "tasks", "推送任务.md"), "utf8");
		expect(prompt).toContain("@im-push-to(ch_企微,ct_111)");
		expect(prompt).toContain("@im-push-to(ch_企微,ct_222)");
		// prompt 正文仍在（标记注入在最前，正文保留）
		expect(prompt).toContain("每天早上汇报");
	});

	// set im-push：向已有任务补充推送目标（去重，不重复加同一 ct）
	test("set im-push 注入推送标记且去重", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, "cron-task.ts");
		writeFileSync(
			join(dir, "tasks", "补.md"),
			'---\nname: "补"\nschedule: {"type":"daily","time":"09:00"}\nagentId: "a"\nprojectId: "__system__"\nenabled: true\n---\n\n任务正文\n',
		);
		const r = Bun.spawnSync(
			[process.execPath, cli, "set", "补", "im-push", "ch_企微,ct_333"],
			{ cwd: dir, env: CLI_ENV },
		);
		expect(r.exitCode).toBe(0);
		const prompt = readFileSync(join(dir, "tasks", "补.md"), "utf8");
		expect(prompt).toContain("@im-push-to(ch_企微,ct_333)");
		expect(prompt).toContain("任务正文");
	});

	// list 显示所属项目：__system__ → 默认工作区；非系统项目 → projectId
	test("list 显示所属项目（系统默认默认工作区，非系统显示 projectId）", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, "cron-task.ts");
		const run = (args: string[]) =>
			Bun.spawnSync([process.execPath, cli, ...args], {
				cwd: dir,
				env: CLI_ENV,
			});
		// 系统默认（__system__，未指定 --project）→ [默认工作区]
		run([
			"add",
			"--name",
			"系统任务",
			"--agent",
			"a",
			"--schedule",
			'{"type":"daily","time":"09:00"}',
			"--prompt",
			"x",
		]);
		// 指定项目 pa → [pa]
		run([
			"add",
			"--name",
			"项目任务",
			"--agent",
			"a",
			"--schedule",
			'{"type":"daily","time":"09:00"}',
			"--project",
			"pa",
			"--prompt",
			"x",
		]);
		const out = run(["list"]).stdout.toString();
		expect(out).toContain("[默认工作区]");
		expect(out).toContain("[pa]");
	});
});
