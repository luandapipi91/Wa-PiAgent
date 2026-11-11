import { describe, test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { KbAgentsModal } from "../KbAgentsModal";
import type { KbInfo } from "@wa-pi/shared";

const puts: Array<[string, any]> = [];
const toastAdd = mock(() => {});

const kb: KbInfo = {
  id: "kb_1",
  name: "慧来客需求",
  description: "",
  folderPath: "/docs",
  status: "ready",
  fileCount: 3,
  chunkCount: 10,
  failedCount: 0,
  autoWatch: true,
  lastIndexedAt: Date.now(),
};

const agentBound = {
  displayName: "研发",
  avatar: "a",
  avatarColor: "#111-#222",
  description: "",
  model: null,
  thinking: null,
  tools: [],
  skills: [],
  mcpServers: [],
  knowledgeBaseIds: ["kb_1"],
  partners: [] as string[],
  systemPromptBody: "正文",
};
const agentFree = { ...agentBound, displayName: "产品", knowledgeBaseIds: undefined };

const subagent = (name: string, bound: boolean) => ({
  name,
  displayName: name,
  description: "",
  emoji: "🤖",
  gradient: ["#111", "#222"],
  readOnly: false,
  systemPrompt: "",
  builtinToolNames: [],
  override: { type: name, model: "m1", thinking: "high", knowledgeBaseIds: bound ? ["kb_1"] : [] },
});

mock.module("../../../store/toast", () => ({
  useToastStore: { getState: () => ({ add: toastAdd, toasts: [] }) },
}));

mock.module("../../../api-client", () => ({
  api: {
    get: mock(async (path: string) => {
      if (path === "/api/agents") return { type: "agent:list", agents: [agentBound, agentFree] };
      if (path === "/api/subagents")
        return { type: "subagent:list", subagents: [subagent("reviewer", false)] };
      return {};
    }),
    post: mock(async () => ({})),
    put: mock(async (path: string, body: unknown) => {
      puts.push([path, body]);
      return {};
    }),
    del: mock(async () => ({})),
  },
}));

beforeEach(() => {
  cleanup();
  puts.length = 0;
  toastAdd.mockReset();
});

describe("KbAgentsModal", () => {
  test("列出命名智能体与内置 subagent，已绑定的勾选态正确", async () => {
    render(<KbAgentsModal kb={kb} onClose={() => {}} />);
    expect(await screen.findByTestId("kb-agent-研发")).toBeTruthy();
    expect(screen.getByTestId("kb-agent-产品")).toBeTruthy();
    expect(screen.getByTestId("kb-agent-reviewer")).toBeTruthy();
    expect((screen.getByTestId("kb-agent-研发") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("kb-agent-产品") as HTMLInputElement).checked).toBe(false);
  });

  test("列表可滚动（固定高度 + overflow）", async () => {
    render(<KbAgentsModal kb={kb} onClose={() => {}} />);
    await screen.findByTestId("kb-agent-研发");
    const list = screen.getByTestId("kb-agents-list");
    expect(list.style.overflowY).toBe("auto");
    expect(list.style.maxHeight).toBeTruthy();
  });

  test("每行只有下边框（列表分隔线），无四边框", async () => {
    render(<KbAgentsModal kb={kb} onClose={() => {}} />);
    const input = await screen.findByTestId("kb-agent-研发");
    const row = input.closest("label") as HTMLElement;
    expect(row.style.border).toBe("");
    expect(row.style.borderTop).toBe("");
    expect(row.style.borderLeft).toBe("");
    expect(row.style.borderRight).toBe("");
    expect(row.style.borderBottom).not.toBe(""); // happy-dom 会把 var() 变量规范化，只断言非空
  });

  test("标题用主题色", async () => {
    render(<KbAgentsModal kb={kb} onClose={() => {}} />);
    const title = await screen.findByText("「慧来客需求」的关联智能体");
    expect(title.className).toContain("text-brand");
    expect(title.className).not.toContain("text-primary");
  });

  test("搜索框不显示浏览器默认黑色聚焦框（outline-none + 主题描边）", async () => {
    render(<KbAgentsModal kb={kb} onClose={() => {}} />);
    await screen.findByTestId("kb-agent-研发");
    const search = screen.getByTestId("kb-agents-search");
    expect(search.className).toContain("outline-none");
    expect(search.className).toContain("focus:border-brand");
    expect(search.style.border).toBe("");
  });

  test("搜索按名称过滤，清空后恢复全部", async () => {
    render(<KbAgentsModal kb={kb} onClose={() => {}} />);
    await screen.findByTestId("kb-agent-研发");
    const search = screen.getByTestId("kb-agents-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "产品" } });
    expect(screen.queryByTestId("kb-agent-研发")).toBeNull();
    expect(screen.getByTestId("kb-agent-产品")).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByTestId("kb-agent-研发")).toBeTruthy();
  });

  test("勾选只暂存，点确认才写入（命名智能体写完整 config）", async () => {
    const onClose = mock(() => {});
    render(<KbAgentsModal kb={kb} onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("kb-agent-产品"));
    expect(puts.length).toBe(0); // 未确认不发请求
    fireEvent.click(screen.getByTestId("kb-agents-confirm"));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0][0]).toBe("/api/agents/%E4%BA%A7%E5%93%81/config");
    expect(puts[0][1].config.knowledgeBaseIds).toEqual(["kb_1"]);
    expect(puts[0][1].config.systemPromptBody).toBe("正文");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  test("取消勾选后确认：knowledgeBaseIds 移除本库；取消按钮不发请求", async () => {
    const onClose = mock(() => {});
    render(<KbAgentsModal kb={kb} onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("kb-agent-研发"));
    fireEvent.click(screen.getByTestId("kb-agents-confirm"));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0][1].config.knowledgeBaseIds).toEqual([]);

    cleanup();
    puts.length = 0;
    onClose.mockReset();
    render(<KbAgentsModal kb={kb} onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("kb-agent-产品"));
    fireEvent.click(screen.getByTestId("kb-agents-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(puts.length).toBe(0);
  });

  test("确认时内置 subagent 保留 model/thinking，PUT override", async () => {
    render(<KbAgentsModal kb={kb} onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("kb-agent-reviewer"));
    fireEvent.click(screen.getByTestId("kb-agents-confirm"));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0][0]).toBe("/api/subagents/override");
    expect(puts[0][1].override).toEqual({
      type: "reviewer",
      model: "m1",
      thinking: "high",
      knowledgeBaseIds: ["kb_1"],
    });
  });

  test("无改动点确认：不发请求直接关闭", async () => {
    const onClose = mock(() => {});
    render(<KbAgentsModal kb={kb} onClose={onClose} />);
    await screen.findByTestId("kb-agent-研发");
    fireEvent.click(screen.getByTestId("kb-agents-confirm"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(puts.length).toBe(0);
  });
});
