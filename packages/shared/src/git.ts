/** Git 分支管理域：前后端共享的类型与纯函数（解析/泳道布局/分支名校验） */

// ============ 类型 ============

/** git 仓库状态（GET /api/projects/:id/git/status 响应体） */
export interface GitStatusResult {
	/** 该目录是否为 git 仓库 */
	isRepo: boolean;
	/** 当前分支名（detached HEAD 时为短 hash） */
	branch: string;
	/** 工作区是否有未提交改动 */
	dirty: boolean;
	/** 领先上游提交数（无上游为 0） */
	ahead: number;
	/** 落后上游提交数（无上游为 0） */
	behind: number;
}

/** 本地分支列表（GET /api/projects/:id/git/branches 响应体） */
export interface GitBranchesResult {
	current: string;
	branches: string[];
}

/** 提交装饰引用：HEAD / 本地分支 / tag / 远端分支 */
export interface GitRef {
	kind: "head" | "branch" | "tag" | "remote";
	name: string;
}

/** 单条提交（用于 Git 图谱渲染） */
export interface GitCommitInfo {
	hash: string;
	/** 父提交 hash 列表（merge 提交有 2+ 个） */
	parents: string[];
	refs: GitRef[];
	author: string;
	/** ISO 8601 日期串（%aI），前端自行格式化 */
	date: string;
	subject: string;
}

/** GET /api/projects/:id/git/log 响应体 */
export interface GitLogResult {
	commits: GitCommitInfo[];
}

/** POST /api/projects/:id/git/pull 响应体 */
export interface GitPullResult {
	ok: boolean;
	/** 合并方式：fast-forward / merge / none（已最新或无变化） */
	mode: "fast-forward" | "merge" | "none" | "unknown";
	/** pull 前的 HEAD（短 hash） */
	from?: string;
	/** pull 后的 HEAD（短 hash） */
	to?: string;
	alreadyUpToDate: boolean;
	filesChanged: number;
	insertions: number;
	deletions: number;
}

// ============ git log 输出解析 ============

/**
 * 解析 `git log --pretty=format:%H%x1f%P%x1f%D%x1f%an%x1f%aI%x1f%s` 的输出。
 * \x1f 作为字段分隔符（提交信息中不可能出现），防提交内容注入错列。
 */
export function parseGitLog(raw: string): GitCommitInfo[] {
	const commits: GitCommitInfo[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		const [hash, parentsRaw, decorationsRaw, author, date, ...subjectParts] =
			line.split("\x1f");
		if (!hash) continue;
		commits.push({
			hash: hash.trim(),
			parents: parentsRaw ? parentsRaw.trim().split(" ").filter(Boolean) : [],
			refs: parseDecorations(decorationsRaw ?? ""),
			author: author ?? "",
			date: date ?? "",
			// subject 里理论上不含 \x1f，但 join 兜底防丢内容
			subject: subjectParts.join("\x1f"),
		});
	}
	return commits;
}

/** 解析 %D 装饰串："HEAD -> master, tag: v0.3.12, origin/master" → GitRef[] */
export function parseDecorations(raw: string): GitRef[] {
	const refs: GitRef[] = [];
	for (const part of raw.split(",")) {
		const token = part.trim();
		if (!token) continue;
		if (token.startsWith("HEAD -> ")) {
			refs.push({ kind: "head", name: "HEAD" });
			refs.push({ kind: "branch", name: token.slice("HEAD -> ".length) });
		} else if (token === "HEAD") {
			refs.push({ kind: "head", name: "HEAD" });
		} else if (token.startsWith("tag: ")) {
			refs.push({ kind: "tag", name: token.slice("tag: ".length) });
		} else if (token.includes("/")) {
			// 启发式：含 / 的视为远端分支（origin/master）
			refs.push({ kind: "remote", name: token });
		} else {
			refs.push({ kind: "branch", name: token });
		}
	}
	return refs;
}

// ============ git pull 输出解析 ============

/** 解析 `git pull` 的 stdout/stderr，提取合并方式与变更统计 */
export function parsePullOutput(
	stdout: string,
	stderr: string,
): Pick<
	GitPullResult,
	"mode" | "alreadyUpToDate" | "filesChanged" | "insertions" | "deletions"
> {
	const text = `${stdout}\n${stderr}`;
	const alreadyUpToDate = /Already up to date/i.test(text);
	let mode: GitPullResult["mode"] = "unknown";
	if (alreadyUpToDate) mode = "none";
	else if (/Fast-forward/.test(text)) mode = "fast-forward";
	else if (/Merge made by/.test(text)) mode = "merge";

	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;
	const stat = text.match(
		/(\d+)\s+files?\s+changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/,
	);
	if (stat) {
		filesChanged = Number(stat[1]);
		insertions = Number(stat[2] ?? 0);
		deletions = Number(stat[3] ?? 0);
	}
	return { mode, alreadyUpToDate, filesChanged, insertions, deletions };
}

// ============ 分支名校验 ============

/**
 * 简化版 git check-ref-format 规则（纯前端预判，后端仍会以 git 实际结果为准）。
 * 拒绝：空、空白/控制字符、..、~^:?*[\、@{、以 / 或 . 或 - 开头、以 / 或 . 结尾、//、组件以 . 开头或以 .lock 结尾。
 */
export function isValidBranchName(name: string): boolean {
	if (!name || name !== name.trim()) return false;
	if (name === "@") return false;
	if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
	if (name.endsWith(".")) return false;
	if (/[\x00-\x20~^:?*[\]\\]/.test(name)) return false;
	if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
	for (const seg of name.split("/")) {
		if (!seg) return false;
		if (seg.startsWith(".") || seg.endsWith(".lock")) return false;
	}
	return true;
}

// ============ Git 图谱泳道布局 ============

export interface GitGraphSegment {
	fromLane: number;
	toLane: number;
	/** 调色板索引（渲染层映射到具体颜色） */
	color: number;
}

/** 单行的泳道布局结果：节点位置 + 向下延伸的竖线 + 分叉/合并斜线 */
export interface GitGraphRow {
	hash: string;
	/** 节点所在列 */
	lane: number;
	color: number;
	/** 本行下方的活跃泳道数（用于 SVG 宽度） */
	laneCount: number;
	/** 竖直延续线（fromLane === toLane） */
	verticals: GitGraphSegment[];
	/** 分叉（节点 → 新父泳道）与合并（被合并泳道 → 节点）斜线 */
	curves: GitGraphSegment[];
}

/**
 * 提交泳道布局（输入须按时间倒序，即 git log 默认顺序）。
 * 维护 activeLanes（每条泳道期望出现的下一个 commit hash）：
 * - 提交被 1 条泳道期望 → 节点落在该泳道；被多条期望 → 其余泳道合并进节点泳道（curves）
 * - 首个 parent 继承节点泳道；其余 parent 若无泳道期望则在其右侧开新泳道（curves）
 */
export function layoutGitLanes(commits: GitCommitInfo[]): GitGraphRow[] {
	const lanes: (string | null)[] = [];
	const laneColors: number[] = [];
	let nextColor = 0;
	const rows: GitGraphRow[] = [];

	for (const commit of commits) {
		const matches: number[] = [];
		for (let i = 0; i < lanes.length; i++) {
			if (lanes[i] === commit.hash) matches.push(i);
		}

		let lane: number;
		if (matches.length > 0) {
			lane = matches[0];
		} else {
			lane = lanes.length;
			lanes.push(null);
			laneColors.push(nextColor++);
		}
		const color = laneColors[lane];

		const curves: GitGraphSegment[] = [];
		// 合并：其他期望本提交的泳道并入节点泳道
		for (const i of matches.slice(1)) {
			curves.push({ fromLane: i, toLane: lane, color: laneColors[i] });
			lanes[i] = null;
		}

		const parents = commit.parents;
		if (parents.length === 0) {
			lanes[lane] = null;
		} else {
			// 首 parent 已被其他泳道期望时「最左泳道获胜」：
			// 本泳道更左 → 本泳道延续，右泳道并入；本泳道更右 → 本泳道并入左泳道
			const existingFirst = lanes.findIndex(
				(h, i) => i !== lane && h === parents[0],
			);
			if (existingFirst >= 0) {
				if (lane < existingFirst) {
					curves.push({
						fromLane: existingFirst,
						toLane: lane,
						color: laneColors[existingFirst],
					});
					lanes[existingFirst] = null;
					lanes[lane] = parents[0];
				} else {
					curves.push({
						fromLane: lane,
						toLane: existingFirst,
						color,
					});
					lanes[lane] = null;
				}
			} else {
				lanes[lane] = parents[0];
			}
			// 其余 parent：已有泳道期望则画斜线，否则右侧开新泳道
			for (const p of parents.slice(1)) {
				const existing = lanes.findIndex((h, i) => i !== lane && h === p);
				if (existing >= 0) {
					curves.push({
						fromLane: lane,
						toLane: existing,
						color: laneColors[existing],
					});
				} else {
					lanes.push(p);
					laneColors.push(nextColor++);
					curves.push({
						fromLane: lane,
						toLane: lanes.length - 1,
						color: nextColor - 1,
					});
				}
			}
		}

		// 回收尾部空泳道
		while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
			lanes.pop();
			laneColors.pop();
		}

		const verticals: GitGraphSegment[] = [];
		for (let i = 0; i < lanes.length; i++) {
			if (lanes[i] !== null) {
				verticals.push({ fromLane: i, toLane: i, color: laneColors[i] });
			}
		}

		rows.push({
			hash: commit.hash,
			lane,
			color,
			laneCount: lanes.length,
			verticals,
			curves,
		});
	}

	return rows;
}
