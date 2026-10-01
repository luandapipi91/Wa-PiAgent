// packages/kernel/src/subagent-cascade-store.ts
// 保留策略（规格 §10）：父会话被**永久删除**时，级联清掉它的子代理转录目录
// （<WA_PI_DIR>/subagents/<parentSessionId>/，见 subagent-instance-store）。
//
// 为什么做成 ProjectStore 的装饰子类，而不是在删除调用点各写一段循环：
// - 永久删除有三个入口：trash:delete → permanentlyDeleteSessions、trash:empty → emptyTrash
//   （都在 ws-server），过期回收 → purgeOldTrashSessions（在 index.ts）。散点接线要各自复制
//   「哪些会话真的被物理移除了」的判定，判定一旦与 store 漂移就会漏删或误删（软删除的绝不能删）。
// - 将被移除的 id 只有 store 自己知道：emptyTrash / purgeOldTrashSessions 只返回数量。
//   在装饰层「删除前记下回收站里的 id、删除后只清其中确实已不在库里的」，判定与删除结果同源。
// - ProjectStore 数据层保持纯净（规格明写不污染），其文件一个字节不动。
// - 挂载点仍只有一处：index.ts 构造 store 处（生产环境唯一的 new ProjectStore()）。
import { ProjectStore } from "./project-store";
import { cleanupSubagentDirs } from "./subagent-instance-store";

class CascadingProjectStore extends ProjectStore {
	async permanentlyDeleteSessions(ids: string[]): Promise<void> {
		await super.permanentlyDeleteSessions(ids);
		// 删除失败（loadStrict 抛错）时上面就中断了：记录还在，转录目录不该被清
		await cleanupSubagentDirs(ids);
	}

	async emptyTrash(): Promise<number> {
		const before = await this.trashedIds();
		const removed = await super.emptyTrash();
		await cleanupSubagentDirs(await this.goneAmong(before));
		return removed;
	}

	async purgeOldTrashSessions(purgeBefore: number): Promise<number> {
		const before = await this.trashedIds();
		const removed = await super.purgeOldTrashSessions(purgeBefore);
		await cleanupSubagentDirs(await this.goneAmong(before));
		return removed;
	}

	/**
	 * 回收站里的全部会话 id。用 load()（原始记录，含回收站 / 占位 / 定时任务会话），
	 * 而不是 loadTrash() —— 后者默认分页 100 条，会漏掉第 100 条之后的会话。
	 * load() 自身容错（读失败回退空库），此时快照为空不做清理：删除操作随后会抛错。
	 */
	private async trashedIds(): Promise<string[]> {
		const { sessions } = await this.load();
		return sessions.filter((s) => s.deletedAt).map((s) => s.id);
	}

	/**
	 * 从快照里筛出「确实已被物理移除」的 id：删除后重新读一次库，仍在库里的（例如这期间
	 * 被用户恢复出回收站）不清理——否则会删掉一个活着的会话的转录。
	 *
	 * 回读用 **strict 读**（loadStrict）而非容错读 load()：load() 的 catch-empty 在瞬时
	 * 读/解析失败时返回空库 → alive 为空集 → 这里会把快照里**所有** id 都判成已删而批量删目录，
	 * 但这些会话可能还躺在回收站里可恢复（fail-open）。故读取失败时返回 null（=「不知道」），
	 * 调用方据此跳过清理：宁漏勿错。
	 */
	protected async aliveSessionIdsStrict(): Promise<Set<string> | null> {
		try {
			const { sessions } = await this.loadStrict();
			return new Set(sessions.map((s) => s.id));
		} catch {
			return null;
		}
	}

	/** 回读失败 → 返回空数组（不清理），绝不因空快照而误删。 */
	private async goneAmong(ids: string[]): Promise<string[]> {
		if (ids.length === 0) return [];
		const alive = await this.aliveSessionIdsStrict();
		if (alive === null) return []; // 读取失败 → 不清理
		return ids.filter((id) => !alive.has(id));
	}
}

/**
 * 创建生产用 ProjectStore：永久删除会话时顺带清理其子代理转录目录。
 * index.ts 是唯一挂载点；测试可传入临时 projects.json（省略则用 PROJECTS_FILE）。
 */
export function createCascadingProjectStore(filePath?: string): ProjectStore {
	return new CascadingProjectStore(filePath);
}
