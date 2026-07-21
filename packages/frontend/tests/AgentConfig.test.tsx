import { test, expect, mock, beforeEach, afterEach, describe } from "bun:test";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { AgentConfig as AgentConfigType } from "@hiagent/shared";
import { AgentConfig } from "../src/components/AgentConfig";
import { useAgentsStore } from "../src/store/agents";
import { useSkillsStore } from "../src/store/skills";
import { useProvidersStore } from "../src/store/providers";

const cfg = (name: string, over: Partial<AgentConfigType> = {}): AgentConfigType => ({
  displayName: name,
  avatar: "🤖",
  avatarColor: "#111111-#222222",
  description: `${name} 简介`,
  model: "glm-4.6",
  thinking: "high",
  systemPromptMode: "replace",
  inheritProjectContext: true,
  inheritSkills: true,
  tools: [],
  skills: [],
  mcpServers: [],
  partners: { askTo: [], askFrom: [] },
  triggerKeywords: [],
  systemPromptBody: "你是工程师",
  ...over,
});

// ws-instance mock：onMessage 暴露触发器模拟 kernel 回包，send 捕获载荷（同 SessionView.test 模式）
const mockHandlers = { list: [] as Array<(e: any) => void> };
const sentEvents: any[] = [];
mock.module("../src/ws-instance", () => ({
  send: (e: any) => { sentEvents.push(e); },
  onMessage: (cb: any) => { mockHandlers.list.push(cb); return () => {}; },
}));

const emitWs = async (e: any) => {
  await act(async () => { mockHandlers.list.forEach(h => h(e)); });
};

beforeEach(() => {
  mockHandlers.list = [];
  sentEvents.length = 0;
  useAgentsStore.setState({ list: [], configs: {} });
  useSkillsStore.setState({ allSkills: [] });
  useProvidersStore.setState({ providers: [] });
});

afterEach(() => cleanup());

function renderConfig(name = "dev", config = cfg(name), onClose = () => {}) {
  useAgentsStore.setState({ configs: { [name]: config } });
  return render(<AgentConfig agentName={name} onClose={onClose} />);
}

const savePayload = () => sentEvents.find(e => e.type === "agent:config:save");
const lastSaved = () => savePayload()!.config;

describe("AgentConfig 4 tab", () => {
  test("渲染 4 个 tab：基本/工具/技能/关系网，无 capabilities", () => {
    renderConfig();
    expect(screen.getByTestId("tab-basic")).toBeTruthy();
    expect(screen.getByTestId("tab-tools")).toBeTruthy();
    expect(screen.getByTestId("tab-skills")).toBeTruthy();
    expect(screen.getByTestId("tab-partners")).toBeTruthy();
    expect(screen.queryByTestId("tab-capabilities")).toBeNull();
  });

  test("弹窗标题显示 displayName", () => {
    renderConfig("dev", cfg("dev", { displayName: "研发" }));
    expect(screen.getByText("研发")).toBeTruthy();
  });

  test("基本 tab：思考档位含'跟随当前'，选 null 保存", () => {
    renderConfig("dev", cfg("dev", { thinking: "high" }));
    const sel = screen.getByTestId("cfg-thinking-select") as HTMLSelectElement;
    expect(sel.value).toBe("high");
    // 含"跟随当前"选项（值为空串）
    const opts = Array.from(sel.options);
    const followOpt = opts.find(o => o.value === "");
    expect(followOpt).toBeTruthy();
    expect(followOpt!.text).toContain("跟随当前");
    fireEvent.change(sel, { target: { value: "" } });
    fireEvent.click(screen.getByText("保存"));
    expect(lastSaved().thinking).toBeNull();
  });

  test("基本 tab：模型下拉来自 providers，含'默认（跟随全局）'可选", () => {
    useProvidersStore.setState({
      providers: [{
        id: "p1", name: "E2E", api: "openai", baseUrl: "https://e",
        apiKey: "k", models: [{ id: "m1", contextWindow: 1, maxTokens: 1 }],
      } as any],
    });
    renderConfig("dev", cfg("dev", { model: null }));
    const sel = screen.getByTestId("cfg-model-select") as HTMLSelectElement;
    expect(sel.value).toBe("");
    // 含"默认（跟随全局）"option，且 enabled
    const opts = Array.from(sel.options);
    const defOpt = opts.find(o => o.value === "");
    expect(defOpt).toBeTruthy();
    expect(defOpt!.text).toContain("默认");
    expect(defOpt!.disabled).toBe(false);
    // 选具体模型保存
    fireEvent.change(sel, { target: { value: "e2e/m1" } });
    fireEvent.click(screen.getByText("保存"));
    expect(lastSaved().model).toContain("m1");
  });

  test("基本 tab：头像颜色选择器已取消（无 cfg-color-1/2，仅留 emoji 输入）", () => {
    renderConfig("dev");
    expect(screen.queryByTestId("cfg-color-1")).toBeNull();
    expect(screen.queryByTestId("cfg-color-2")).toBeNull();
    expect(screen.getByTestId("cfg-avatar-input")).toBeTruthy();
  });

  test("关键词 chips：回车添加（trim + 去重），✕ 删除", () => {
    renderConfig();
    const input = screen.getByTestId("kw-input");
    fireEvent.change(input, { target: { value: " 排期 " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("kw-chip-排期")).toBeTruthy();
    // 去重：相同关键词再次回车不新增
    fireEvent.change(input, { target: { value: "排期" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByTestId("kw-chip-排期")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("kw-chip-x-排期"));
    expect(screen.queryByTestId("kw-chip-排期")).toBeNull();
  });

  test("关系网 tab：搜索过滤 + 自身置灰不可选 + 勾选写入 askTo", () => {
    useAgentsStore.setState({ list: [cfg("dev"), cfg("代码审查"), cfg("质量验收")] });
    renderConfig("dev");
    fireEvent.click(screen.getByTestId("tab-partners"));
    expect(screen.getByTestId("partner-check-代码审查")).toBeTruthy();
    // 自身行置灰且禁用
    const self = screen.getByTestId("partner-check-dev") as HTMLInputElement;
    expect(self.closest(".opacity-50, [aria-disabled='true']")).toBeTruthy();
    expect(self.disabled).toBe(true);
    // 搜索过滤
    fireEvent.change(screen.getByTestId("partner-search"), { target: { value: "审查" } });
    expect(screen.queryByTestId("partner-check-质量验收")).toBeNull();
    expect(screen.getByTestId("partner-check-代码审查")).toBeTruthy();
    // 勾选写入 partners.askTo 并保存
    fireEvent.click(screen.getByTestId("partner-check-代码审查"));
    fireEvent.click(screen.getByText("保存"));
    expect(savePayload().config.partners.askTo).toEqual(["代码审查"]);
  });

  test("工具 tab：空数组展示为全勾，取消勾选后保存为非空列表", async () => {
    renderConfig();
    fireEvent.click(screen.getByTestId("tab-tools"));
    await emitWs({ type: "agent:tools:list", tools: [{ name: "read", source: "内置" }, { name: "bash", source: "内置" }] });
    const readChk = (await screen.findByTestId("tool-check-read")) as HTMLInputElement;
    const bashChk = (await screen.findByTestId("tool-check-bash")) as HTMLInputElement;
    // tools 为空 = 全量默认 → 展示态全部勾选
    expect(readChk.checked).toBe(true);
    expect(bashChk.checked).toBe(true);
    fireEvent.click(bashChk);
    fireEvent.click(screen.getByText("保存"));
    expect(savePayload().config.tools).toEqual(["read"]);
  });

  test("技能 tab：勾选写入 skills", () => {
    useSkillsStore.setState({
      allSkills: [
        { name: "pdf", description: "PDF 处理", path: "/p/pdf" },
        { name: "web", description: "网页访问", path: "/p/web" },
      ],
    });
    renderConfig();
    fireEvent.click(screen.getByTestId("tab-skills"));
    const pdfChk = screen.getByTestId("skill-check-pdf") as HTMLInputElement;
    expect(pdfChk.checked).toBe(true);
    fireEvent.click(screen.getByTestId("skill-check-web"));
    fireEvent.click(screen.getByText("保存"));
    expect(savePayload().config.skills).toEqual(["pdf"]);
  });

  test("改名保存：载荷 config.displayName 更新，agentName 保持原名", () => {
    renderConfig("技术实现", cfg("技术实现"));
    fireEvent.change(screen.getByTestId("cfg-name-input"), { target: { value: "新名字" } });
    fireEvent.click(screen.getByText("保存"));
    const payload = savePayload();
    expect(payload.agentName).toBe("技术实现");
    expect(payload.config.displayName).toBe("新名字");
  });

  test("重名时显示错误且禁用保存（不发出 agent:config:save）", () => {
    // store 里已有另一个 "代码审查"
    useAgentsStore.setState({ list: [cfg("代码审查")] });
    renderConfig("技术实现", cfg("技术实现"));
    // 改成已存在的 "代码审查"
    fireEvent.change(screen.getByTestId("cfg-name-input"), { target: { value: "代码审查" } });
    // 显示重名错误
    expect(screen.getByTestId("cfg-name-error").textContent).toContain("已被占用");
    // 保存按钮禁用
    const saveBtn = screen.getByTestId("cfg-save");
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
    // 点击保存也不发出消息
    fireEvent.click(saveBtn);
    expect(savePayload()).toBeUndefined();
  });

  test("改为自身原名不视为重名（可正常保存）", () => {
    useAgentsStore.setState({ list: [cfg("技术实现")] });
    renderConfig("技术实现", cfg("技术实现"));
    // 不改名，直接保存
    fireEvent.click(screen.getByTestId("cfg-save"));
    expect(savePayload()).toBeDefined();
  });

  test("displayName 为空时禁用保存", () => {
    renderConfig("技术实现", cfg("技术实现"));
    fireEvent.change(screen.getByTestId("cfg-name-input"), { target: { value: "" } });
    const saveBtn = screen.getByTestId("cfg-save");
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });

  test("点保存触发 onClose", () => {
    const onClose = mock();
    renderConfig("dev", cfg("dev"), onClose);
    fireEvent.click(screen.getByText("保存"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("AgentConfig 内置 subagent（只读模式）", () => {
  test("打开 general-purpose 显示内置提示，无保存按钮", () => {
    render(<AgentConfig agentName="general-purpose" onClose={() => {}} />);
    expect(screen.getByTestId("cfg-builtin-notice")).toBeTruthy();
    expect(screen.getByTestId("cfg-builtin-notice").textContent).toContain("内置");
    // 无保存按钮，只有"关闭"
    expect(screen.queryByTestId("cfg-save")).toBeNull();
    expect(screen.getByText("关闭")).toBeTruthy();
  });

  test("内置 subagent 不发送 agent:config:get（避免 kernel 报错）", () => {
    render(<AgentConfig agentName="Explore" onClose={() => {}} />);
    const getConfigCall = sentEvents.find(e => e.type === "agent:config:get");
    expect(getConfigCall).toBeUndefined();
  });

  test("内置 subagent 显示中文显示名（来自 SUBAGENT_TYPES）", () => {
    render(<AgentConfig agentName="general-purpose" onClose={() => {}} />);
    // header 显示 SUBAGENT_TYPES 里的 displayName（"通用子智能体"）
    expect(screen.getByTestId("agent-config").textContent).toContain("通用子智能体");
  });

  test("内置 subagent tab 内容区有置灰样式（opacity-60 + pointer-events-none）", () => {
    render(<AgentConfig agentName="Explore" onClose={() => {}} />);
    const content = screen.getByTestId("config-tab-content");
    expect(content.className).toContain("opacity-60");
    expect(content.className).toContain("pointer-events-none");
  });
});
