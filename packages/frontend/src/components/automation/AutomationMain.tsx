import { Modal } from "../ui/Modal";
import { useSchedulerStore } from "../../store/scheduler";
import { TaskDetailView } from "./TaskDetailView";
import { TaskEditForm } from "./TaskEditForm";
import { ExecutionRecords } from "./ExecutionRecords";

/**
 * 自动化主内容区（store 驱动，无 props）。
 * 主区默认页规则：
 * - 选中任务 → 任务详情
 * - 未选中但有任务 → 执行记录
 * - 无任务 → 新建引导页（「+ 新建」直达 startCreate）
 * edit 态以 Modal 弹窗叠加表单（新建/编辑共用），关闭统一走 setView("detail")。
 */
export function AutomationMain() {
	const { view, tasks, selectedTaskId, editingTask, setView, startCreate } =
		useSchedulerStore();
	const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;

	// 主区 header 反映主区内容（edit 表单在弹窗中，不占主区标题）
	const mainHeader =
		view === "records"
			? "⚡ 执行记录"
			: selectedTask
				? `⚡ ${selectedTask.name}`
				: tasks.length > 0
					? "⚡ 执行记录"
					: "⚡ 定时任务";

	return (
		<>
			<div
				className="flex items-center px-4 py-3 border-b border-hairline"
				data-testid="automation-main-header"
			>
				<span className="text-sm font-semibold text-primary">{mainHeader}</span>
			</div>
			<div className="flex-1 overflow-y-auto p-4">
				{view === "records" ? (
					<ExecutionRecords />
				) : selectedTask ? (
					<TaskDetailView />
				) : tasks.length > 0 ? (
					<ExecutionRecords />
				) : (
					<div
						className="flex flex-col items-center justify-center h-full gap-3"
						data-testid="automation-empty-guide"
					>
						<span className="text-3xl">⚡</span>
						<span className="text-sm" style={{ color: "var(--text-secondary)" }}>
							暂无定时任务
						</span>
						<button
							onClick={startCreate}
							className="text-[11px] px-3.5 py-1.5 rounded border-0 cursor-pointer font-medium"
							style={{ background: "var(--accent)", color: "white" }}
							data-testid="automation-guide-new-btn"
						>
							+ 新建自动化
						</button>
					</div>
				)}
			</div>
			{view === "edit" && (
				<Modal
					onClose={() => setView("detail")}
					width={640}
					// 新建/编辑表单弹窗：误点阴影会丢输入，仅允许「取消/保存」关闭
					closeOnOverlayClick={false}
					data-testid="task-edit-modal"
				>
					<div
						className="flex items-center px-4 py-3 border-b border-hairline"
						data-testid="task-edit-modal-title"
					>
						<span className="text-sm font-semibold text-primary">
							{editingTask ? "编辑自动化" : "新建自动化"}
						</span>
					</div>
					<div className="overflow-y-auto p-4" style={{ maxHeight: "70vh" }}>
						<TaskEditForm />
					</div>
				</Modal>
			)}
		</>
	);
}
