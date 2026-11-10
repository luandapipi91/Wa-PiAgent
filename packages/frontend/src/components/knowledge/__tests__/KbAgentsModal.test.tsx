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
    expect((screen.getByTestId("kb-agent-reviewer") as HTMLInputElement).checked).toBe(false);
  });

  test("勾选命名智能体：PUT 完整 config 且 knowledgeBaseIds 含本库", async () => {
    render(<KbAgentsModal kb={kb} onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("kb-agent-产品"));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0][0]).toBe("/api/agents/%E4%BA%A7%E5%93%81/config");
    expect(puts[0][1].config.knowledgeBaseIds).toEqual(["kb_1"]);
    expect(puts[0][1].config.systemPromptBody).toBe("正文"); // 不丢正文
  });

  test("取消勾选命名智能体：knowledgeBaseIds 移除本库", async () => {
    render(<KbAgentsModal kb={kb} onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("kb-agent-研发"));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0][1].config.knowledgeBaseIds).toEqual([]);
  });

  test("勾选内置 subagent：保留 model/thinking，PUT override", async () => {
    render(<KbAgentsModal kb={kb} onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("kb-agent-reviewer"));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0][0]).toBe("/api/subagents/override");
    expect(puts[0][1].override).toEqual({
      type: "reviewer",
      model: "m1",
      thinking: "high",
      knowledgeBaseIds: ["kb_1"],
    });
  });
});
