import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";

// 复用真实 contactOf（纯函数）；仅 mock store 的 hook/getState。
import { contactOf } from "../../store/contacts";

const renameContact = mock(async () => {});
const ensureContact = mock(async () => ({ id: "ct_new" }));

const state = {
	contacts: [] as any[],
	renameContact,
	ensureContact,
};
const useContactsStore = (selector: (s: typeof state) => unknown) =>
	selector(state);
(useContactsStore as any).getState = () => state;

mock.module("../../store/contacts", () => ({ useContactsStore, contactOf }));

const { default: ImSessionTitle } = await import("../ImSessionTitle");

/** 构造 IM 会话信息，字段可覆盖 */
function imConv(over: Record<string, unknown> = {}): any {
	return {
		channelId: "ch_a",
		channelName: "企微",
		channelType: "wecom",
		chatId: "u1",
		chatType: "single",
		fromUserId: "u1",
		sessionId: "s1",
		projectId: "p1",
		projectName: "proj",
		lastMessagePreview: "hi",
		updatedAt: 1000,
		...over,
	};
}

function contact(over: Record<string, unknown> = {}): any {
	return {
		id: "ct_1",
		channelId: "ch_a",
		kind: "person",
		userId: "u1",
		firstChatAt: 1,
		lastChatAt: 2,
		...over,
	};
}

beforeEach(() => {
	renameContact.mockReset();
	ensureContact.mockReset();
	state.contacts = [];
});
afterEach(() => cleanup());

test("无备注名：显示技术标题（sessionTitle）", () => {
	render(<ImSessionTitle sessionTitle="IM · u1" imConv={imConv()} />);
	expect(screen.getByText("IM · u1")).toBeTruthy();
	expect(screen.getByTestId("im-session-title-edit")).toBeTruthy();
});

test("单聊有备注名：显示 IM · remark", () => {
	state.contacts = [contact({ remark: "张总" })];
	render(<ImSessionTitle sessionTitle="IM · u1" imConv={imConv()} />);
	expect(screen.getByText("IM · 张总")).toBeTruthy();
	expect(screen.queryByText("IM · u1")).toBeNull();
});

test("群聊有备注名：按 chatId 匹配显示 IM · remark", () => {
	state.contacts = [
		contact({
			kind: "group",
			userId: undefined,
			chatId: "g12345678",
			remark: "项目群",
		}),
	];
	render(
		<ImSessionTitle
			sessionTitle="IM · 群g1234567 · user_bob"
			imConv={imConv({ chatType: "group", chatId: "g12345678", fromUserId: "user_bob" })}
		/>,
	);
	expect(screen.getByText("IM · 项目群")).toBeTruthy();
});

test("点铅笔进入行内编辑：输入框预填当前备注名", () => {
	state.contacts = [contact({ remark: "张总" })];
	render(<ImSessionTitle sessionTitle="IM · u1" imConv={imConv()} />);
	fireEvent.click(screen.getByTestId("im-session-title-edit"));
	const input = screen.getByTestId(
		"im-session-title-input",
	) as HTMLInputElement;
	expect(input.value).toBe("张总");
});

test("点铅笔（无备注）输入框为空", () => {
	render(<ImSessionTitle sessionTitle="IM · u1" imConv={imConv()} />);
	fireEvent.click(screen.getByTestId("im-session-title-edit"));
	expect(
		(screen.getByTestId("im-session-title-input") as HTMLInputElement).value,
	).toBe("");
});

test("已有联系人：输入 + Enter 保存调用 renameContact", async () => {
	state.contacts = [contact({ remark: "张总" })];
	render(<ImSessionTitle sessionTitle="IM · u1" imConv={imConv()} />);
	fireEvent.click(screen.getByTestId("im-session-title-edit"));
	const input = screen.getByTestId("im-session-title-input");
	fireEvent.change(input, { target: { value: "李四" } });
	fireEvent.keyDown(input, { key: "Enter" });
	await act(async () => {});
	expect(renameContact).toHaveBeenCalledWith("ct_1", "李四");
	expect(ensureContact).not.toHaveBeenCalled();
});

test("已有联系人：输入 + 失焦保存调用 renameContact", async () => {
	state.contacts = [contact({})];
	render(<ImSessionTitle sessionTitle="IM · u1" imConv={imConv()} />);
	fireEvent.click(screen.getByTestId("im-session-title-edit"));
	const input = screen.getByTestId("im-session-title-input");
	fireEvent.change(input, { target: { value: "王五" } });
	fireEvent.blur(input);
	await act(async () => {});
	expect(renameContact).toHaveBeenCalledWith("ct_1", "王五");
});

test("Esc 取消：不调用 renameContact，输入框消失", () => {
	state.contacts = [contact({ remark: "张总" })];
	render(<ImSessionTitle sessionTitle="IM · u1" imConv={imConv()} />);
	fireEvent.click(screen.getByTestId("im-session-title-edit"));
	const input = screen.getByTestId("im-session-title-input");
	fireEvent.keyDown(input, { key: "Escape" });
	expect(screen.queryByTestId("im-session-title-input")).toBeNull();
	expect(renameContact).not.toHaveBeenCalled();
});

test("无联系人：保存先 ensureContact 再 renameContact（自动补建）", async () => {
	ensureContact.mockImplementation(async () => ({ id: "ct_auto" }));
	render(<ImSessionTitle sessionTitle="IM · u1" imConv={imConv()} />);
	fireEvent.click(screen.getByTestId("im-session-title-edit"));
	const input = screen.getByTestId("im-session-title-input");
	fireEvent.change(input, { target: { value: "新朋友" } });
	fireEvent.keyDown(input, { key: "Enter" });
	await act(async () => {});
	expect(ensureContact).toHaveBeenCalledWith({
		channelId: "ch_a",
		kind: "person",
		userId: "u1",
	});
	expect(renameContact).toHaveBeenCalledWith("ct_auto", "新朋友");
});

test("无联系人且输入为空：不创建联系人", async () => {
	render(<ImSessionTitle sessionTitle="IM · u1" imConv={imConv()} />);
	fireEvent.click(screen.getByTestId("im-session-title-edit"));
	const input = screen.getByTestId("im-session-title-input");
	fireEvent.blur(input);
	await act(async () => {});
	expect(ensureContact).not.toHaveBeenCalled();
	expect(renameContact).not.toHaveBeenCalled();
});
