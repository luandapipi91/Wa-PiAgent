// projects store setAll 行为：currentSessionId 的保留/清空。
// 回归 bug：新会话首次发送时，乐观添加的会话在 kernel projects:list 快照里尚未可见
// （placeholder 未转正/列表滞后），setAll 若清空 currentSessionId → 视图闪回新建页。
// 真删除场景由删除 handler 显式清 currentSessionId（不依赖 setAll）。
import { expect, test } from "bun:test";
import { useProjectsStore } from "./projects";

const p = { id: "proj-1", name: "P1", cwd: "/p1", createdAt: 0 };
const mk = (id: string) => ({
	id,
	projectId: "proj-1",
	primaryAgent: "dev",
	title: "t",
	createdAt: 1,
	lastActivity: 1,
	piSessionFile: "",
});

test("setAll 收到不含当前会话的列表（kernel 快照滞后）→ 保留 currentSessionId，防首次发送闪回", () => {
	useProjectsStore.setState({
		projects: [p] as any,
		sessions: [mk("s-opt")] as any,
		currentProjectId: "proj-1",
		currentSessionId: "s-opt",
	});
	// kernel projects:list 快照里该会话尚未可见（placeholder 未转正）→ 只含另一个会话
	useProjectsStore.getState().setAll([p] as any, [mk("s-other")] as any);
	expect(useProjectsStore.getState().currentSessionId).toBe("s-opt");
});

test("setAll 新列表不含当前会话且旧 store 也没有（真删除）→ 清空 currentSessionId", () => {
	useProjectsStore.setState({
		projects: [p] as any,
		sessions: [],
		currentProjectId: "proj-1",
		currentSessionId: "s-gone",
	});
	useProjectsStore.getState().setAll([p] as any, [mk("s-other")] as any);
	expect(useProjectsStore.getState().currentSessionId).toBeNull();
});
