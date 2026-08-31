import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// 预设技能列表（组件内 skills 非空时不会触发 load 请求）
const { useState } = await import("react");
const { useSkillsStore } = await import("../src/store/skills");
const { SkillSuggestTextarea } = await import("../src/components/ui/SkillSuggestTextarea");

function Host() {
	const [v, setV] = useState("");
	return <SkillSuggestTextarea value={v} onChange={setV} data-testid="ta" />;
}

beforeEach(() => {
	useSkillsStore.setState({
		skills: [
			{ name: "brainstorming", description: "头脑风暴", path: "/x" },
			{ name: "tdd", description: "测试驱动", path: "/y" },
		] as any,
	});
});
afterEach(() => cleanup());

test("输入 $ 触发技能列表；继续输入按名称过滤", () => {
	render(<Host />);
	const ta = screen.getByTestId("ta") as HTMLTextAreaElement;
	fireEvent.change(ta, { target: { value: "$" } });
	expect(screen.getByTestId("skill-suggest-list")).toBeTruthy();
	expect(screen.getByTestId("skill-suggest-item-brainstorming")).toBeTruthy();
	fireEvent.change(ta, { target: { value: "$td" } });
	expect(screen.queryByTestId("skill-suggest-item-brainstorming")).toBeNull();
	expect(screen.getByTestId("skill-suggest-item-tdd")).toBeTruthy();
});

test("点击技能项 → 插入 $[名] 替换 $query 片段", () => {
	render(<Host />);
	const ta = screen.getByTestId("ta") as HTMLTextAreaElement;
	fireEvent.change(ta, { target: { value: "你是客服。 $brain" } });
	fireEvent.mouseDown(screen.getByTestId("skill-suggest-item-brainstorming"));
	expect(ta.value).toBe("你是客服。 $[brainstorming]");
	expect(screen.queryByTestId("skill-suggest-list")).toBeNull();
});

test("无 $ 触发符 → 不出列表；Esc 关闭列表", () => {
	render(<Host />);
	const ta = screen.getByTestId("ta") as HTMLTextAreaElement;
	fireEvent.change(ta, { target: { value: "普通文本" } });
	expect(screen.queryByTestId("skill-suggest-list")).toBeNull();
	fireEvent.change(ta, { target: { value: "$t" } });
	expect(screen.getByTestId("skill-suggest-list")).toBeTruthy();
	fireEvent.keyDown(ta, { key: "Escape" });
	expect(screen.queryByTestId("skill-suggest-list")).toBeNull();
});
