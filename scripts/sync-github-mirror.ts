// GitHub 镜像同步脚本：把本地 HEAD 的完整快照同步到 github.com/luandapipi91/Wa-PiAgent（main）。
//
// 背景：该镜像仓库的 git 端点连接被重置（git push 会挂起超时），但 api.github.com 可达，
// 因此走 Git Data API 做「快照式同步」：
//   1) 以远端当前 tree 为 base，算出「内容变化/新增/删除」的条目（未变化的由 base_tree 复用）；
//   2) 只校验并补传这些条目的 blob（base64）；
//   3) 提交增量 tree，创建无父快照 commit，强推 main。
// 幂等：重复执行安全（已存在的 blob/tree 由 GitHub 去重复用）。
//
// 用法：
//   bun scripts/sync-github-mirror.ts [--skip-verify] [--message <覆盖提交信息>]
// 凭据：从 git credential fill（host=github.com）读取 PAT，需已配置。
// 注意：docs/superpowers/ 等被 .gitignore 忽略的路径不在 git ls-tree 里，天然不上传。
import { execSync } from "node:child_process";

const REPO = "luandapipi91/Wa-PiAgent";
const BRANCH = "main";
const API = `https://api.github.com/repos/${REPO}`;

export interface TreeEntry {
	path: string;
	mode: string;
	type: "blob";
	sha: string | null;
}

export interface LsTreeEntry {
	mode: string;
	sha: string;
	path: string;
}

/** 解析 git ls-tree -r 输出行："mode blob <sha>\t<path>"。非 blob 行（tree/commit 等）返回 null。 */
export function parseLsTreeLine(line: string): LsTreeEntry | null {
	const tab = line.indexOf("\t");
	if (tab < 52) return null;
	if (line.slice(7, 11) !== "blob") return null;
	return {
		mode: line.slice(0, 6),
		sha: line.slice(12, 52),
		path: line.slice(tab + 1),
	};
}

/** 组装要提交的 tree 条目：只含「内容变化 / 新增」的文件与远端多余文件的删除。
 *  内容未变的条目交给 base_tree 复用——全量 upsert（每个文件一条）会让
 *  POST /git/trees 的请求体上千条，GitHub 侧构树超时（实测 504，重试还会挂住），
 *  而且这些条目每次内容都一样、纯属无谓流量。 */
export function buildEntries(
	local: LsTreeEntry[],
	remoteShas: ReadonlyMap<string, string>,
): TreeEntry[] {
	const entries: TreeEntry[] = [];
	const localPaths = new Set<string>();
	for (const e of local) {
		localPaths.add(e.path);
		if (remoteShas.get(e.path) === e.sha) continue; // 内容一致：由 base_tree 复用
		entries.push({ path: e.path, mode: e.mode, type: "blob", sha: e.sha });
	}
	for (const p of remoteShas.keys()) {
		if (!localPaths.has(p)) {
			entries.push({ path: p, mode: "100644", type: "blob", sha: null });
		}
	}
	return entries;
}

/** 判断内容是否二进制（前 8KB 含 NUL 字节）。 */
export function looksBinary(bytes: Uint8Array): boolean {
	const scan = Math.min(8000, bytes.length);
	for (let i = 0; i < scan; i++) {
		if (bytes[i] === 0) return true;
	}
	return false;
}

function gh<T>(
	method: string,
	path: string,
	pat: string,
	body?: unknown,
): Promise<T> {
	return fetch(`${API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${pat}`,
			Accept: "application/vnd.github+json",
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	}).then(async (res) => {
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`GitHub API ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
			);
		}
		return res.json() as Promise<T>;
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 带重试的 GH 调用（429/403/5xx 退避重试 3 次）。 */
async function ghRetry<T>(
	method: string,
	path: string,
	pat: string,
	body: unknown,
	log: (s: string) => void,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await gh<T>(method, path, pat, body);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const retriable = /429|403|500|502|503|504/.test(msg);
			if (attempt >= 2 || !retriable) throw err;
			log(`  retry (${attempt + 1}): ${msg.slice(0, 120)}`);
			await sleep(15_000);
		}
	}
}

function gitOut(args: string[], input?: string): Buffer {
	try {
		return execSync(["git", ...args].join(" "), {
			input,
			maxBuffer: 1024 * 1024 * 64,
		}) as Buffer;
	} catch (err) {
		throw new Error(
			`git ${args.join(" ")} 失败：${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function getPat(): string {
	const out = gitOut(
		["credential", "fill"],
		"protocol=https\nhost=github.com\n\n",
	).toString("utf8");
	const m = out.match(/^password=(.+)$/m);
	if (!m)
		throw new Error("git credential fill 未取到 github.com 的 PAT，请先配置凭据");
	return m[1];
}

async function main() {
	const args = process.argv.slice(2);
	const skipVerify = args.includes("--skip-verify");
	const msgIdx = args.indexOf("--message");
	// 取不到本地 commit 信息时回退占位信息（不让 git log 的失败中断同步）
	let localMessage = "";
	try {
		localMessage = execSync("git log -1 --pretty=%B").toString("utf8").trim();
	} catch {
		/* 非 git 环境等：用占位信息 */
	}
	const message =
		msgIdx >= 0 && args[msgIdx + 1] ? args[msgIdx + 1] : localMessage || "sync";

	const pat = getPat();
	const log = (s: string) => console.log(s);

	// 1. 本地全量清单
	const local = gitOut(["ls-tree", "-r", "HEAD"])
		.toString("utf8")
		.split("\n")
		.filter(Boolean)
		.map(parseLsTreeLine)
		.filter((e): e is LsTreeEntry => e !== null);
	log(`local files: ${local.length}`);

	// 2. 远端当前 ref/commit/tree
	const ref = await ghRetry<{ object: { sha: string } }>(
		"GET",
		`/git/ref/heads/${BRANCH}`,
		pat,
		undefined,
		log,
	);
	const commit0 = await ghRetry<{ tree: { sha: string } }>(
		"GET",
		`/git/commits/${ref.object.sha}`,
		pat,
		undefined,
		log,
	);
	const baseTreeSha = commit0.tree.sha;
	log(`remote base tree: ${baseTreeSha}`);

	// 3. 远端 tree（path → sha）→ 只提交真正变化的条目（未变化的由 base_tree 复用）
	const remoteTree = await ghRetry<{
		tree: { path: string; sha: string; type: string }[];
	}>("GET", `/git/trees/${baseTreeSha}?recursive=1`, pat, undefined, log);
	const remoteShas = new Map<string, string>(
		remoteTree.tree
			.filter((t) => t.type === "blob")
			.map((t) => [t.path, t.sha] as [string, string]),
	);
	const entries = buildEntries(local, remoteShas);
	const upserts = entries.filter((e) => e.sha !== null);
	const deletes = entries.length - upserts.length;
	log(
		`tree entries: upsert=${upserts.length} delete=${deletes} unchanged=${local.length - upserts.length}`,
	);

	// 4. 只校验本次要提交的 blob（未变化文件的 blob 必然已在远端），缺失则补传（base64）
	if (skipVerify) {
		log("blob verify skipped (--skip-verify)");
	} else {
		let missing = 0;
		let uploaded = 0;
		for (const e of upserts) {
			let exists = true;
			try {
				await gh("GET", `/git/blobs/${e.sha}`, pat, undefined);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (!msg.includes("404")) throw err;
				exists = false;
			}
			if (exists) continue;
			missing++;
			const bytes = gitOut(["cat-file", "blob", e.sha as string]);
			const body = looksBinary(bytes)
				? { content: Buffer.from(bytes).toString("base64"), encoding: "base64" }
				: { content: bytes.toString("utf8") };
			await ghRetry("POST", "/git/blobs", pat, body, log);
			uploaded++;
			if (uploaded % 25 === 0)
				log(`  verified+uploaded: missing=${missing} uploaded=${uploaded}`);
		}
		log(`blob verify: missing=${missing} re-uploaded=${uploaded}`);
	}

	// 5. 增量 tree → 快照 commit → 强推
	const newTree = await ghRetry<{ sha: string }>(
		"POST",
		"/git/trees",
		pat,
		{ base_tree: baseTreeSha, tree: entries },
		log,
	);
	log(`new tree: ${newTree.sha}`);
	const newCommit = await ghRetry<{ sha: string }>(
		"POST",
		"/git/commits",
		pat,
		{ message, tree: newTree.sha, parents: [] },
		log,
	);
	log(`new commit: ${newCommit.sha}`);
	await ghRetry(
		"PATCH",
		`/git/refs/heads/${BRANCH}`,
		pat,
		{ sha: newCommit.sha, force: true },
		log,
	);

	// 6. 验证
	const verify = await gh<{ object: { sha: string } }>(
		"GET",
		`/git/ref/heads/${BRANCH}`,
		pat,
		undefined,
	);
	if (verify.object.sha === newCommit.sha) {
		log(`MIRROR SYNC OK: ${REPO}@${BRANCH} -> ${verify.object.sha}`);
	} else {
		log("REF MISMATCH!");
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exitCode = 1;
});
