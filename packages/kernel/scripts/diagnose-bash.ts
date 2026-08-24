// Windows「No bash shell found」诊断桩（只在问题电脑上跑，不修改任何生产代码）。
//
// 目的：定位打包版 / 无 Git Bash 的 Windows 上，kernel 的自动 bash 接线（bash-runtime.ts）
// 到底断在哪一环。逐步骤打点，把过程和结果写入 <cwd>/bash-diag-report.txt，便于收集。
//
// 覆盖场景：
//   1. 环境信息（platform/arch/env 关键变量）
//   2. findSystemBash() 系统 bash 检测
//   3. portableBashDir / portableBashExe 实际路径
//   4. 缓存里是否已有可用 PortableGit bash（bashVersionOf）
//   5. 调生产 ensurePortableBash()（真实下载+解压），拿返回值
//   6. ensurePortableBash 返回 null 时，用精细打点版复刻 download/extract，定位失败点
//      （HTTP 状态、字节数、SFX 解压 exit code、bash --version 输出）
//   7. 读 WA_PI_DIR/settings.json 看 shellPath 当前值（pi 引擎读的就是它）

import {
	existsSync,
	mkdirSync,
	statSync,
	writeFileSync,
	appendFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import {
	findSystemBash,
	portableBashDir,
	portableBashExe,
	portableBashDownloadUrls,
	bashVersionOf,
	bashSpawnEnv,
	ensurePortableBash,
	ensureBashAvailable,
	PORTABLE_GIT_VERSION,
} from "../src/bash-runtime";

const REPORT = join(process.cwd(), "bash-diag-report.txt");
let reportLines: string[] = [];

function log(line: string): void {
	reportLines.push(line);
	console.log(line);
}
function flush(): void {
	try {
		mkdirSync(dirname(REPORT), { recursive: true });
		appendFileSync(REPORT, reportLines.join("\n") + "\n\n");
	} catch (e) {
		console.error("写入报告失败:", e);
	}
}

function section(title: string): void {
	log(`\n===== ${title} =====`);
}

/** 白名单：PortableGit 下载源的域名（诊断桩只允许访问固定镜像，禁止任意 URL）。 */
const ALLOWED_DOWNLOAD_HOSTS = [
	"registry.npmmirror.com",
	"cdn.npmmirror.com",
	"github.com",
];

/** 仅当 url 的 host 在固定白名单内才允许 fetch（防 SSRF；下载源本为白名单常量）。 */
function isAllowedDownloadUrl(rawUrl: string): boolean {
	try {
		const h = new URL(rawUrl).hostname;
		return ALLOWED_DOWNLOAD_HOSTS.some((a) => h === a || h.endsWith("." + a));
	} catch {
		return false;
	}
}

/** 精细打点版下载（测真实断点用，不写缓存，仅诊断） */
async function diagDownload(): Promise<{
	url: string;
	status: number;
	bytes: number;
} | null> {
	for (const url of portableBashDownloadUrls()) {
		log(`[diag] 尝试下载: ${url}`);
		try {
			if (!isAllowedDownloadUrl(url)) {
				log(`[diag]   URL 不在白名单，跳过: ${url}`);
				continue;
			}
			const res = await fetch(url, {
				redirect: "follow",
				signal: AbortSignal.timeout(120_000),
			});
			log(`[diag]   HTTP ${res.status}`);
			if (!res.ok || !res.body) {
				log(`[diag]   非 2xx 或无 body，跳过`);
				continue;
			}
			const buf = Buffer.from(await res.arrayBuffer());
			log(`[diag]   收到 ${buf.length} bytes`);
			return { url, status: res.status, bytes: buf.length };
		} catch (e) {
			log(`[diag]   下载异常: ${(e as Error).message}`);
		}
	}
	return null;
}

/** 精细打点版 SFX 解压（不落盘数据，仅诊断——用临时目录解压到目标后再校验） */
function diagExtract(sfxPath: string, destDir: string): boolean {
	try {
		mkdirSync(destDir, { recursive: true });
		const r = spawnSync(sfxPath, ["-o" + destDir, "-y"], {
			encoding: "utf8",
			timeout: 120_000,
			windowsHide: true,
			stdio: "pipe",
		});
		log(`[diag] SFX 解压 exit=${r.status}`);
		if (r.status !== 0) {
			log(`[diag]   stderr: ${r.stderr?.slice(-500)}`);
			return false;
		}
		const exe = join(destDir, "bin", "bash.exe");
		log(`[diag]   解压后 bash.exe 存在 = ${existsSync(exe)}`);
		if (existsSync(exe)) {
			const v = bashVersionOf(exe);
			log(`[diag]   bash --version 校验 = ${v ?? "(null, 失败)"}`);
		}
		return existsSync(exe) && bashVersionOf(exe) !== null;
	} catch (e) {
		log(`[diag] 解压异常: ${(e as Error).message}`);
		return false;
	}
}

async function main(): Promise<void> {
	// 用日期起头，方便多次跑区分
	reportLines = [];
	log(`========== wa-pi bash 诊断 @ ${new Date().toISOString()} ==========`);

	section("1. 环境信息");
	log(`platform = ${process.platform}`);
	log(`arch = ${process.arch}`);
	log(`ProgramFiles = ${process.env.ProgramFiles ?? "(未设)"}`);
	log(`ProgramFiles(x86) = ${process.env["ProgramFiles(x86)"] ?? "(未设)"}`);
	log(`LOCALAPPDATA = ${process.env.LOCALAPPDATA ?? "(未设)"}`);
	log(`USERPROFILE = ${process.env.USERPROFILE ?? "(未设)"}`);
	log(`HOME = ${process.env.HOME ?? "(未设)"}`);
	log(`WA_PI_DIR = ${process.env.WA_PI_DIR ?? "(未设，默认 ~/.pi/agent)"}`);
	log(`PATH = ${process.env.PATH ?? "(未设)"}`);
	log(`WA_PI_BASH_CACHE_DIR = ${process.env.WA_PI_BASH_CACHE_DIR ?? "(未设)"}`);

	section("2. findSystemBash() 系统 bash 检测");
	const sysBash = findSystemBash();
	log(`结果 = ${sysBash ?? "(null = 系统无 bash)"}`);
	if (sysBash) {
		log(`系统 bash --version = ${bashVersionOf(sysBash)}`);
	}

	section("3. PortableGit 路径");
	log(`portableBashDir() = ${portableBashDir()}`);
	log(`portableBashExe() = ${portableBashExe()}`);
	log(`portableBashDir 存在 = ${existsSync(portableBashDir())}`);
	const cachedBash = portableBashExe();
	log(`缓存 bash.exe 存在 = ${existsSync(cachedBash)}`);
	if (existsSync(cachedBash)) {
		log(`缓存 bash --version = ${bashVersionOf(cachedBash)}`);
	}
	log(`下载 URL 列表:`);
	for (const u of portableBashDownloadUrls()) log(`  - ${u}`);

	section("4. 调用生产 ensurePortableBash()（真实下载+解压，可能耗时）");
	const produced = await ensurePortableBash();
	log(`ensurePortableBash 返回 = ${produced ?? "(null = 失败)"}`);
	if (produced) {
		log(`生产链路返回的 bash --version = ${bashVersionOf(produced)}`);
		log(`生产链路已经可用，诊断结束（说明 shellPath 可能未接线或时序问题）`);
		flush();
		return;
	}

	section("5. ensurePortableBash 返回 null —— 用精细打点版定位失败点");
	log(`这一点确认了「下载或解压」环节真实失败。下面逐个定位：`);

	// 5a. 精细下载
	log(`--- 5a. 精细下载（模拟 downloadPortableGit）---`);
	const dl = await diagDownload();
	if (dl) {
		log(
			`[结论] 下载本身 OK（${dl.url} → HTTP ${dl.status}，${dl.bytes} bytes）。`,
		);
		log(`      那问题在「解压」环节。下面 5b 复刻 extractPortableGit：`);

		// 5b. 精细解压：下载一个临时副本解压做诊断（不动生产缓存）
		log(`--- 5b. 精细解压 ---`);
		const diagTmp = join(tmpdir(), `wa-pi-bash-diag-${Date.now()}`);
		mkdirSync(diagTmp, { recursive: true });
		const sfxPath = join(diagTmp, "PortableGit-sfx.7z.exe");
		log(`下载临时副本到 ${sfxPath} 用于解压诊断...`);
		const dlRes = await fetch(dl.url, {
			redirect: "follow",
			signal: AbortSignal.timeout(120_000),
		});
		if (dlRes.ok && dlRes.body) {
			const buf = Buffer.from(await dlRes.arrayBuffer());
			writeFileSync(sfxPath, buf);
			log(`临时副本 ${buf.length} bytes 就绪`);
			const destDir = join(diagTmp, "extract");
			const ok = diagExtract(sfxPath, destDir);
			if (ok) {
				log(`[结论] 解压 OK！那生产故障可能不在此，而是路径/权限/时序问题。`);
				log(
					`      PortableGit 解压到 ${portableBashDir()} 是否成功？请检查: ${portableBashDir()}`,
				);
				log(`      缓存目录是否可写？权限是否受限？`);
			} else {
				log(`[结论] 解压失败（SFX exit 非 0 或 bash 校验失败）。这是根因之一。`);
				log(
					`      常见原因：SFX 在目标机器被杀软拦截 / 解压到 LOCALAPPDATA 权限不足 / usr/bin DLL 缺失。`,
				);
			}
		} else {
			log(`[diag] 二次下载（解压诊断用）失败: HTTP ${dlRes.status}`);
		}
	} else {
		log(`[结论] 下载失败（两个源都不可达/非 2xx/过小）。这是根因之一。`);
	}

	section("6. 调用生产 ensureBashAvailable()（完整入口）");
	const available = await ensureBashAvailable();
	log(`ensureBashAvailable 返回 = ${available ?? "(null)"}`);

	section("7. settings.json.shellPath 当前值");
	const piDir = process.env.WA_PI_DIR || join(homedir(), ".pi", "agent");
	const settingsPath = join(piDir, "settings.json");
	log(`expected settings.json = ${settingsPath}`);
	log(`settings.json 存在 = ${existsSync(settingsPath)}`);
	if (existsSync(settingsPath)) {
		try {
			const raw = JSON.parse(
				require("node:fs").readFileSync(settingsPath, "utf8"),
			);
			log(
				`settings.json.shellPath = ${raw.shellPath ?? "(未设置 → 这就是 pi 读到空的原因)"}`,
			);
		} catch (e) {
			log(`读取 settings.json 失败: ${(e as Error).message}`);
		}
	} else {
		log(`settings.json 不存在 → kernel 从未 saveShellPath，pi 读不到 shellPath`);
	}

	section("结论汇总");
	log(`- 系统 bash（findSystemBash）: ${sysBash ?? "无"}`);
	log(`- PortableGit 生产链路: ${produced ? "可用" : "失败(null)"}`);
	log(
		`- settings.json.shellPath: ${(() => {
			try {
				const r = JSON.parse(
					require("node:fs").readFileSync(join(piDir, "settings.json"), "utf8"),
				);
				return r.shellPath ?? "(未设置)";
			} catch {
				return "(读不到)";
			}
		})()}`,
	);
	log(`- 详见上方各环节日志。`);
	flush();
}

main().catch((e) => {
	log(`诊断脚本异常: ${(e as Error).message}`);
	flush();
});
