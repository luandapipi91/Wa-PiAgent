/**
 * Git 分支管理域服务（kernel 端）：封装 git 子进程调用。
 *
 * - runGit：Bun.spawn 数组参数（不经 shell，防注入）、默认 15s 超时 kill、
 *   并发排空 stdout/stderr 防管道阻塞。
 * - 状态改变操作（checkout/建分支/pull）经模块级队列串行，防并发互踩 index.lock。
 */
import { KernelError } from "./kernel-error";
import { drainLines } from "./npm-package-service";
import { parseGitLog, parsePullOutput } from "@wa-pi/shared";
import type {
	GitStatusResult,
	GitBranchesResult,
	GitLogResult,
	GitPullResult,
} from "@wa-pi/shared";

/** git 子进程默认超时：本地操作正常秒级完成，15s 无结果判异常 */
export const GIT_TIMEOUT_MS = 15_000;
/** pull 可能走网络，放宽到 60s */
export const GIT_PULL_TIMEOUT_MS = 60_000;

export interface RunGitOpts {
	/** 子进程超时（ms），默认 GIT_TIMEOUT_MS */
	timeoutMs?: number;
	/** git 可执行文件（默认 PATH 查找；测试注入不存在路径以覆盖 git.unavailable 分支） */
	gitBin?: string;
}

export interface RunGitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** 执行 git 子进程。git 不存在抛 git.unavailable；超时 kill 并抛 git.timeout。 */
export async function runGit(
	cwd: string,
	args: string[],
	opts: RunGitOpts = {},
): Promise<RunGitResult> {
	// gitBin（测试注入）> WA_PI_GIT_BIN（指定自定义/内置 git 路径）> PATH 查找；
	// 解析不到统一抛 git.unavailable。环境变量每次调用现读，运行期可改。
	const git = Bun.which(opts.gitBin ?? process.env.WA_PI_GIT_BIN ?? "git");
	if (!git) throw new KernelError("git.unavailable");
	const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
	const proc = Bun.spawn([git, ...args], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			proc.kill();
		} catch {
			/* 进程可能已退出 */
		}
	}, timeoutMs);
	try {
		const [stdout, stderr] = await Promise.all([
			drainLines(proc.stdout),
			drainLines(proc.stderr),
		]);
		const exitCode = await proc.exited;
		if (timedOut)
			throw new KernelError("git.timeout", undefined, `git ${args.join(" ")}`);
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

/** 非仓库目录统一判空：rev-parse 失败即抛 git.notRepo（路由层按需转 200 isRepo:false） */
async function assertRepo(cwd: string): Promise<void> {
	const r = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (r.exitCode !== 0)
		throw new KernelError("git.notRepo", undefined, r.stderr.trim());
}

/** 仓库状态：分支名 / 脏标记 / 领先落后上游计数（无上游 0/0） */
export async function gitStatus(cwd: string): Promise<GitStatusResult> {
	await assertRepo(cwd);
	// 空仓库 rev-parse --abbrev-ref HEAD 失败，容错为空串分支
	const branchR = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const branch = branchR.exitCode === 0 ? branchR.stdout.trim() : "";
	const statusR = await runGit(cwd, ["status", "--porcelain"]);
	const dirty = statusR.exitCode === 0 && statusR.stdout.trim().length > 0;
	// 无上游时 rev-list 失败（exit≠0），按 0/0 处理
	const abR = await runGit(cwd, [
		"rev-list",
		"--left-right",
		"--count",
		"HEAD...@{upstream}",
	]);
	let ahead = 0;
	let behind = 0;
	if (abR.exitCode === 0) {
		const [a, b] = abR.stdout.trim().split(/\s+/);
		ahead = Number(a) || 0;
		behind = Number(b) || 0;
	}
	return { isRepo: true, branch, dirty, ahead, behind };
}

/** 本地分支列表（字典序，与 git branch 默认输出一致） */
export async function gitBranches(cwd: string): Promise<GitBranchesResult> {
	await assertRepo(cwd);
	const currentR = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const current = currentR.exitCode === 0 ? currentR.stdout.trim() : "";
	const listR = await runGit(cwd, ["branch", "--format=%(refname:short)"]);
	const branches =
		listR.exitCode === 0
			? listR.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
			: [];
	return { current, branches };
}

/** git log 输出格式：\x1f 字段分隔（提交内容不可能含该字符，防注入错列） */
const LOG_FORMAT = "--pretty=format:%H%x1f%P%x1f%D%x1f%an%x1f%aI%x1f%s";

/** 提交历史（时间倒序）。空仓库（无 HEAD）返回空数组而非报错。 */
export async function gitLog(cwd: string, limit = 200): Promise<GitLogResult> {
	await assertRepo(cwd);
	// 空仓库：HEAD 不存在，直接返回空
	const headR = await runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
	if (headR.exitCode !== 0) return { commits: [] };
	const r = await runGit(cwd, ["log", LOG_FORMAT, "-n", String(limit)]);
	if (r.exitCode !== 0)
		throw new KernelError("git.logFailed", undefined, r.stderr.trim());
	return { commits: parseGitLog(r.stdout) };
}

/** 模块级操作队列：改变仓库状态的操作（checkout/建分支/pull）串行执行，
 *  防并发互踩 index.lock（与 npm-package-service 同款跨实例互斥理由） */
let opQueue: Promise<void> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
	const run = opQueue.then(op);
	// 队列吞错：单个操作失败不影响后续排队操作（错误由调用方自行处理）
	opQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** 切换分支（锁内）。失败抛 git.checkoutFailed（detail 为 git stderr）。 */
export async function gitCheckout(cwd: string, branch: string): Promise<void> {
	await enqueue(async () => {
		await assertRepo(cwd);
		const r = await runGit(cwd, ["checkout", branch]);
		if (r.exitCode !== 0)
			throw new KernelError("git.checkoutFailed", undefined, r.stderr.trim());
	});
}

/** 新建并切换分支（锁内）。失败抛 git.branchFailed（如分支已存在）。 */
export async function gitCreateBranch(
	cwd: string,
	name: string,
): Promise<void> {
	await enqueue(async () => {
		await assertRepo(cwd);
		const r = await runGit(cwd, ["checkout", "-b", name]);
		if (r.exitCode !== 0)
			throw new KernelError("git.branchFailed", undefined, r.stderr.trim());
	});
}

/** 当前 HEAD 短 hash；空仓库/异常返回 undefined */
async function shortHead(cwd: string): Promise<string | undefined> {
	const r = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
	return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined;
}

/** 拉取上游（锁内，`git pull --no-edit`，60s 超时）。
 *  返回合并方式/前后 HEAD/变更统计；失败（无上游、冲突等）抛 git.pullFailed。 */
export async function gitPull(cwd: string): Promise<GitPullResult> {
	return enqueue(async () => {
		await assertRepo(cwd);
		const from = await shortHead(cwd);
		const r = await runGit(cwd, ["pull", "--no-edit"], {
			timeoutMs: GIT_PULL_TIMEOUT_MS,
		});
		if (r.exitCode !== 0)
			throw new KernelError("git.pullFailed", undefined, r.stderr.trim());
		const to = await shortHead(cwd);
		const parsed = parsePullOutput(r.stdout, r.stderr);
		return { ok: true, from, to, ...parsed };
	});
}
