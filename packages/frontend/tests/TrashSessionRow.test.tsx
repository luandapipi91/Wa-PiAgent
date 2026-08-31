import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { TrashSessionRow } from "../src/components/TrashSessionRow";

const baseSession = {
	id: "s1",
	projectId: "p1",
	primaryAgent: "dev",
	title: "帮我写周报",
	createdAt: 0,
	lastActivity: Date.now() - 3600_000,
	deletedAt: Date.now() - 1800_000,
	deletedReason: "auto" as const,
};

function renderRow(overrides: Partial<typeof baseSession> = {}) {
	return render(
		<TrashSessionRow
			session={{ ...baseSession, ...overrides } as any}
			project={{ id: "p1", name: "项目A", cwd: "/tmp", createdAt: 0 } as any}
			selected={false}
			onToggleSelect={() => {}}
			onView={() => {}}
		/>,
	);
}

test("归档区行：第一列会话标题、第二列角色", () => {
	renderRow();
	const title = screen.getByText("帮我写周报");
	const role = screen.getByText("dev");
	// 标题在角色之前（第一列 → 第二列）
	expect(
		title.compareDocumentPosition(role) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	// 标题列弹性：占满剩余空间、可收缩、超宽省略（原 w-40 固定宽截断显示过少）
	expect(title.className).toContain("flex-1");
	expect(title.className).toContain("min-w-0");
	expect(title.className).toContain("truncate");
	expect(title.className).not.toContain("w-40");
});

test("IM 会话同样显示标题 + 保留 IM 标识", () => {
	render(
		<TrashSessionRow
			session={
				{
					...baseSession,
					id: "im-abc123",
					title: "IM · f3a9b1c2",
				} as any
			}
			project={undefined}
			selected={false}
			onToggleSelect={() => {}}
			onView={() => {}}
		/>,
	);
	expect(screen.getByText("IM · f3a9b1c2")).toBeTruthy();
	expect(screen.getByTestId("trash-row-im-tag")).toBeTruthy();
});
