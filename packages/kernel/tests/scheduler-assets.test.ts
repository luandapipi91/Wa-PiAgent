import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureScheduledTasksAssets } from "../src/scheduler-assets";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wa-pi-assets-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ensureScheduledTasksAssets", () => {
	test("首次调用创建目录结构 + CLI + README", async () => {
		await ensureScheduledTasksAssets(dir);
		expect(existsSync(join(dir, ".wa-pi/scheduled-tasks/tasks"))).toBe(true);
		expect(existsSync(join(dir, ".wa-pi/scheduled-tasks/logs"))).toBe(true);
		const cli = readFileSync(join(dir, ".wa-pi/scheduled-tasks/cron-task.ts"), "utf8");
		expect(cli).toContain("wa-pi-cron-task-asset v");
		expect(existsSync(join(dir, ".wa-pi/scheduled-tasks/README.md"))).toBe(true);
	});

	test("已是最新版 → 不覆盖（用户可能在 README 旁加了笔记文件，不动它们）", async () => {
		await ensureScheduledTasksAssets(dir);
		const note = join(dir, ".wa-pi/scheduled-tasks/NOTE.md");
		writeFileSync(note, "我的笔记");
		await ensureScheduledTasksAssets(dir);
		expect(readFileSync(note, "utf8")).toBe("我的笔记");
	});

	test("旧版本戳 → 覆盖升级 CLI 与 README", async () => {
		await ensureScheduledTasksAssets(dir);
		const cliPath = join(dir, ".wa-pi/scheduled-tasks/cron-task.ts");
		writeFileSync(cliPath, "// wa-pi-cron-task-asset v0\n旧内容");
		await ensureScheduledTasksAssets(dir);
		expect(readFileSync(cliPath, "utf8")).not.toContain("旧内容");
	});
});

describe("cron-task.ts CLI", () => {
	test("help / add / list / validate / test 全链路", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, ".wa-pi/scheduled-tasks/cron-task.ts");
		const run = (args: string[]) =>
			Bun.spawnSync(["bun", cli, ...args], { cwd: dir, env: process.env });
		expect(run(["help"]).exitCode).toBe(0);

		const add = run([
			"add", "--name", "每日站会", "--agent", "main",
			"--schedule", '{"type":"daily","time":"09:30"}',
			"--prompt", "提醒站会",
		]);
		expect(add.exitCode).toBe(0);
		expect(existsSync(join(dir, ".wa-pi/scheduled-tasks/tasks/每日站会.md"))).toBe(true);

		const list = run(["list"]);
		expect(list.stdout.toString()).toContain("每日站会");

		expect(run(["validate", "每日站会"]).exitCode).toBe(0);
		const testOut = run(["test", "每日站会"]);
		expect(testOut.exitCode).toBe(0);
		expect(testOut.stdout.toString()).toContain("09:30");

		// 非法文件校验失败：exitCode 1 + 中文错误
		writeFileSync(join(dir, ".wa-pi/scheduled-tasks/tasks/坏.md"), "没有 frontmatter");
		const bad = run(["validate", "坏"]);
		expect(bad.exitCode).toBe(1);
		expect(bad.stderr.toString() + bad.stdout.toString()).toContain("frontmatter");
	});

	test("run 在 kernel 不在线时明确报错", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, ".wa-pi/scheduled-tasks/cron-task.ts");
		const r = Bun.spawnSync(["bun", cli, "run", "任意"], {
			cwd: dir,
			env: { ...process.env, WA_PI_DIR: join(dir, "no-kernel") }, // 无 kernel.json
		});
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString() + r.stdout.toString()).toContain("kernel");
	});

	// 路径穿越：id 含 ../ 必须拒绝，不能写出 tasks/ 目录外
	test("任务 id 路径穿越被拒绝", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, ".wa-pi/scheduled-tasks/cron-task.ts");
		const r = Bun.spawnSync(["bun", cli, "set", "../escape/out", "name", "X"], {
			cwd: dir,
			env: process.env,
		});
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString() + r.stdout.toString()).toContain("id 非法");
		expect(existsSync(join(dir, ".wa-pi/escape"))).toBe(false);
	});

	// cron 步进 */0 必须报错而非死循环（与 shared parseField 同规则）
	test("cron 步进 */0 报错退出（不死循环）", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, ".wa-pi/scheduled-tasks/cron-task.ts");
		writeFileSync(
			join(dir, ".wa-pi/scheduled-tasks/tasks/零步.md"),
			'---\nname: "零步"\nschedule: {"type":"custom","time":"00:00","cronExpression":"*/0 * * * *"}\nagentId: "main"\nenabled: true\n---\n\n测试\n',
		);
		const r = Bun.spawnSync(["bun", cli, "test", "零步"], { cwd: dir, env: process.env });
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString() + r.stdout.toString()).toContain("步进");
	});

	// schedule.type 枚举校验（与 shared validateTaskData 同规则）
	test("schedule.type 非法时 validate 失败", async () => {
		await ensureScheduledTasksAssets(dir);
		const cli = join(dir, ".wa-pi/scheduled-tasks/cron-task.ts");
		writeFileSync(
			join(dir, ".wa-pi/scheduled-tasks/tasks/年.md"),
			'---\nname: "年"\nschedule: {"type":"yearly","time":"09:30"}\nagentId: "main"\nenabled: true\n---\n\n提示\n',
		);
		const r = Bun.spawnSync(["bun", cli, "validate", "年"], { cwd: dir, env: process.env });
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString() + r.stdout.toString()).toContain("schedule.type");
	});
});
