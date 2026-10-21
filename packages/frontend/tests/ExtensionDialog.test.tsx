// ExtensionDialog.test.tsx — pi 扩展 dialog 弹窗（select/confirm/input/editor）组件测试
// mock api-client（仿 Composer.test.tsx 模式），断言各 method 的渲染与应答 POST 载荷。
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const sent: any[] = [];

mock.module("../src/api-client", () => ({
  api: {
    get: () => Promise.resolve({}),
    post: (path: string, body?: any) => {
      sent.push({ path, body });
      return Promise.resolve({});
    },
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
      this.name = "ApiError";
    }
  },
}));

import { ExtensionDialog } from "../src/components/ExtensionDialog";
import { useExtDialogStore } from "../src/store/ext-dialog";

const RESPOND_PATH = "/api/extensions/dialog/respond";

function lastRespond() {
  return sent.filter((s) => s.path === RESPOND_PATH).at(-1);
}

beforeEach(() => {
  sent.length = 0;
  useExtDialogStore.setState({ queue: [] });
});

describe("ExtensionDialog", () => {
  it("队列为空时不渲染弹窗", () => {
    render(<ExtensionDialog sessionId="s1" />);
    expect(screen.queryByTestId("modal-overlay")).toBeNull();
  });

  it("confirm：渲染 title/message，点「确认」POST { requestId, confirmed: true }", async () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r1",
      sessionId: "s1",
      method: "confirm",
      title: "删除文件",
      message: "确定要删除吗？",
    });
    render(<ExtensionDialog sessionId="s1" />);

    expect(screen.getByText("删除文件")).toBeTruthy();
    expect(screen.getByText("确定要删除吗？")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ext-dialog-ok"));

    await waitFor(() => {
      expect(lastRespond()?.body).toEqual({ requestId: "r1", confirmed: true });
    });
    // 应答后弹出队列
    expect(useExtDialogStore.getState().queue).toHaveLength(0);
  });

  it("confirm：点「取消」POST { requestId, cancelled: true }", async () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r2",
      sessionId: "s1",
      method: "confirm",
      title: "t",
      message: "m",
    });
    render(<ExtensionDialog sessionId="s1" />);

    fireEvent.click(screen.getByTestId("ext-dialog-cancel"));

    await waitFor(() => {
      expect(lastRespond()?.body).toEqual({ requestId: "r2", cancelled: true });
    });
  });

  it("select：渲染 options 按钮，点某项 POST { requestId, value: option }", async () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r3",
      sessionId: "s1",
      method: "select",
      title: "选择方案",
      options: ["方案A", "方案B"],
    });
    render(<ExtensionDialog sessionId="s1" />);

    expect(screen.getByText("选择方案")).toBeTruthy();
    fireEvent.click(screen.getByText("方案B"));

    await waitFor(() => {
      expect(lastRespond()?.body).toEqual({ requestId: "r3", value: "方案B" });
    });
  });

  it("select：ESC / 点击遮罩不取消（只有「取消」按钮才取消）", async () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r4",
      sessionId: "s1",
      method: "select",
      title: "t",
      options: ["A"],
    });
    render(<ExtensionDialog sessionId="s1" />);

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByTestId("modal-overlay"));

    // 两种误触路径都不应应答、弹窗仍在
    await new Promise((r) => setTimeout(r, 50));
    expect(lastRespond()).toBeUndefined();
    expect(useExtDialogStore.getState().queue).toHaveLength(1);
    expect(screen.getByTestId("ext-dialog")).toBeTruthy();

    // 只有「取消」按钮才取消
    fireEvent.click(screen.getByTestId("ext-dialog-cancel"));
    await waitFor(() => {
      expect(lastRespond()?.body).toEqual({ requestId: "r4", cancelled: true });
    });
    expect(useExtDialogStore.getState().queue).toHaveLength(0);
  });

  it("input：单行输入（placeholder）提交 POST { value }；取消 POST { cancelled: true }", async () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r5",
      sessionId: "s1",
      method: "input",
      title: "输入名称",
      placeholder: "请输入…",
    });
    render(<ExtensionDialog sessionId="s1" />);

    const input = screen.getByTestId("ext-dialog-input") as HTMLInputElement;
    expect(input.placeholder).toBe("请输入…");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("ext-dialog-ok"));

    await waitFor(() => {
      expect(lastRespond()?.body).toEqual({ requestId: "r5", value: "hello" });
    });
  });

  it("editor：textarea 带 prefill，提交 POST { value: 编辑后文本 }", async () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r6",
      sessionId: "s1",
      method: "editor",
      title: "编辑内容",
      prefill: "原始文本",
    });
    render(<ExtensionDialog sessionId="s1" />);

    const textarea = screen.getByTestId(
      "ext-dialog-editor",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("原始文本");
    fireEvent.change(textarea, { target: { value: "改过的文本" } });
    fireEvent.click(screen.getByTestId("ext-dialog-ok"));

    await waitFor(() => {
      expect(lastRespond()?.body).toEqual({
        requestId: "r6",
        value: "改过的文本",
      });
    });
  });

  it("队列按序展示：应答当前后自动展示下一个请求", async () => {
    useExtDialogStore
      .getState()
      .enqueue({
        requestId: "r7",
        sessionId: "s1",
        method: "confirm",
        title: "第一个",
        message: "m1",
      });
    useExtDialogStore
      .getState()
      .enqueue({
        requestId: "r8",
        sessionId: "s1",
        method: "confirm",
        title: "第二个",
        message: "m2",
      });
    render(<ExtensionDialog sessionId="s1" />);

    expect(screen.getByText("第一个")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ext-dialog-ok"));

    await waitFor(() => {
      expect(screen.getByText("第二个")).toBeTruthy();
    });
    expect(useExtDialogStore.getState().queue).toHaveLength(1);
  });

  it("会话锁定：其它会话的 pending 请求不在当前会话渲染", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r9",
      sessionId: "s-other",
      method: "confirm",
      title: "别的会话",
      message: "m",
    });
    render(<ExtensionDialog sessionId="s1" />);

    expect(screen.queryByTestId("modal-overlay")).toBeNull();
    // 队列不受影响：切到对应会话仍可展示
    expect(useExtDialogStore.getState().queue).toHaveLength(1);
  });

  it("会话锁定：应答当前会话请求后，其它会话的 pending 保持不变", async () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r10",
      sessionId: "s-other",
      method: "confirm",
      title: "别的会话",
      message: "m",
    });
    useExtDialogStore.getState().enqueue({
      requestId: "r11",
      sessionId: "s1",
      method: "confirm",
      title: "当前会话",
      message: "m",
    });
    render(<ExtensionDialog sessionId="s1" />);

    expect(screen.getByText("当前会话")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ext-dialog-ok"));

    await waitFor(() => {
      expect(lastRespond()?.body).toEqual({
        requestId: "r11",
        confirmed: true,
      });
    });
    const remain = useExtDialogStore.getState().queue;
    expect(remain).toHaveLength(1);
    expect(remain[0].requestId).toBe("r10");
  });

  it("尺寸：Modal 卡片 inline 宽 60% + 高上限 80vh，内容区可滚动（内容多时不溢出屏幕）", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r12",
      sessionId: "s1",
      method: "confirm",
      title: "t",
      message: "m",
    });
    render(<ExtensionDialog sessionId="s1" />);

    const card = screen.getByTestId("ext-dialog") as HTMLElement;
    expect(card.style.width).toBe("60%");
    expect(card.style.maxHeight).toBe("80vh");
    // message 所在的内容区容器带滚动样式（header/footer 固定，中间区滚动）
    const body = screen.getByTestId("ext-dialog-message") as HTMLElement;
    expect(body.className).toContain("overflow-y-auto");
  });
});

/** pi-goal-x 提案确认那种体量的正文（数十行，远超卡片高度） */
const LONG_MESSAGE = Array.from(
  { length: 40 },
  (_, i) =>
    `第 ${i + 1} 行：确认第 ${i + 1} 段验收口径并将其写进目标契约（含边界、约束、验收证据）。`,
).join("\n");

function seedSelect(options = ["甲", "乙", "丙"], message = LONG_MESSAGE) {
  useExtDialogStore.getState().enqueue({
    requestId: "r1",
    sessionId: "s1",
    method: "select",
    title: "Confirm Goal Draft",
    message,
    options,
  });
}

describe("ExtensionDialog 终端排版归一化", () => {
  /**
   * pi-goal-x 的真实形态（goal-draft.ts:34 给每行加 `│   ` 前缀）：被前缀挡住的
   * markdown 表格/分节线都解析不出来 —— 用户报的「表格没渲染出来」就是它。
   */
  const PI_GOAL_TEXT = [
    "● Goal draft ready for confirmation.",
    "",
    "─── Draft Details ───",
    "│   Mode: Normal goal",
    "│   Auto-continue: yes",
    "",
    "─── Proposed Goal ───",
    "",
    "│   **目标**：完成一次演示",
    "│   | 阶段 | 产出 |",
    "│   | --- | --- |",
    "│   | 一 | 验证报告 |",
    "",
    "┌─ TASKS ──────────────────────┐",
    "│ [ ] task-1：确认 goal 契约    │",
    "└──────────────────────────────┘",
  ].join("\n");

  it("表格/分节线/复选框都渲染成真元素", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r20",
      sessionId: "s1",
      method: "select",
      title: PI_GOAL_TEXT,
      options: ["甲"],
    });
    render(<ExtensionDialog sessionId="s1" />);

    const title = screen.getByTestId("ext-dialog-title");
    // 表格：真 <table>，且单元格内容正确
    const table = title.querySelector("table");
    expect(table).not.toBeNull();
    const cells = Array.from(table!.querySelectorAll("td,th")).map((c) => c.textContent);
    expect(cells).toContain("阶段");
    expect(cells).toContain("验证报告");
    // 分节线 → 小标题
    const headings = Array.from(title.querySelectorAll("h3")).map((h) => h.textContent);
    expect(headings).toEqual(["Draft Details", "Proposed Goal", "TASKS"]);
    // 任务行保留文本（pi 的 `[ ] xxx` 不带列表符，按 gfm 规则不是任务列表项，不做额外改写）
    expect(title.textContent).toContain("[ ] task-1：确认 goal 契约");
    // 原始框线字符不得再露出
    expect(title.textContent).not.toContain("│");
    expect(title.textContent).not.toContain("───");
    // 高度契约不能被破坏
    expect(title.className).toContain("overflow-y-auto");
    expect(title.className).toContain("max-h-");
  });

  it("message 同样归一化", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r21",
      sessionId: "s1",
      method: "confirm",
      title: "确认",
      message: PI_GOAL_TEXT,
    });
    render(<ExtensionDialog sessionId="s1" />);

    const message = screen.getByTestId("ext-dialog-message");
    expect(message.querySelector("table")).not.toBeNull();
    expect(message.querySelectorAll("h3")).toHaveLength(3);
  });
});

describe("ExtensionDialog 高度约束", () => {
  it("正文区是唯一滚动区，选项区固定在按钮上方且不参与压缩", () => {
    seedSelect();
    render(<ExtensionDialog sessionId="s1" />);

    const message = screen.getByTestId("ext-dialog-message");
    expect(message.className).toContain("overflow-y-auto");
    expect(message.className).toContain("min-h-0");

    const actions = screen.getByTestId("ext-dialog-actions");
    // 决策区不可压缩：否则 flex 会把它压成一条缝（正文越长压得越狠）
    expect(actions.className).toContain("shrink-0");
    // 决策区不在滚动区里面：正文再长也推不走它
    expect(message.contains(actions)).toBe(false);
    // 选项按钮自身同样不可压缩
    for (const btn of screen.getAllByTestId("ext-dialog-option")) {
      expect(btn.className).toContain("shrink-0");
    }
    // 取消按钮仍在（唯一取消路径）
    expect(screen.getByTestId("ext-dialog-cancel")).toBeDefined();
  });

  /**
   * 真实形态：pi 的 select 把长长的 prompt 放在 **title**（截图里那坨几十行目标草案就是它），
   * message 反而是空的。头部不限高 → 卡片被撑满 → 选项与按钮被整个挤出卡片（卡片
   * overflow-hidden，用户连滚都滚不到）。头部必须限高自滚，决策区优先。
   */
  it("长标题（pi 的 select 就是这么传长 prompt）限高自滚，不挤走选项", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r4",
      sessionId: "s1",
      method: "select",
      title: LONG_MESSAGE,
      options: ["甲", "乙", "丙"],
    });
    render(<ExtensionDialog sessionId="s1" />);

    const title = screen.getByTestId("ext-dialog-title");
    expect(title.className).toContain("overflow-y-auto");
    expect(title.className).toMatch(/max-h-/);
    // 头部整行不可压缩 + ✕ 常驻
    expect(title.parentElement!.className).toContain("shrink-0");
    expect(screen.getByTestId("ext-dialog-close")).toBeDefined();
    // 选项与取消按钮都在（且不在标题区里）
    expect(screen.getByTestId("ext-dialog-options")).toBeDefined();
    expect(screen.getByTestId("ext-dialog-cancel")).toBeDefined();
    expect(title.contains(screen.getByTestId("ext-dialog-options"))).toBe(false);
  });

  it("选项列表超长时自己滚动，取消按钮仍留在卡片内", () => {
    seedSelect(Array.from({ length: 40 }, (_, i) => `选项 ${i + 1}`));
    render(<ExtensionDialog sessionId="s1" />);

    const list = screen.getByTestId("ext-dialog-options");
    expect(list.className).toContain("overflow-y-auto");
    expect(list.className).toMatch(/max-h-/);
    // 选项列表不是取消按钮的祖先：列表滚到底也不影响按钮位置
    expect(list.contains(screen.getByTestId("ext-dialog-cancel"))).toBe(false);
  });

  it("input/editor 同样不受长正文挤压（决策区固定可见）", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r2",
      sessionId: "s1",
      method: "editor",
      title: "demo editor",
      message: LONG_MESSAGE,
    });
    render(<ExtensionDialog sessionId="s1" />);

    const actions = screen.getByTestId("ext-dialog-actions");
    expect(actions.className).toContain("shrink-0");
    expect(
      actions.contains(screen.getByTestId("ext-dialog-editor")),
    ).toBe(true);
    expect(
      screen.getByTestId("ext-dialog-message").contains(actions),
    ).toBe(false);
  });
});

describe("ExtensionDialog 尺寸与行结构", () => {
  it("弹窗尺寸：宽 60%、高上限 80vh", () => {
    seedSelect();
    render(<ExtensionDialog sessionId="s1" />);

    const card = screen.getByTestId("ext-dialog") as HTMLElement;
    expect(card.style.width).toBe("60%");
    expect(card.style.maxHeight).toBe("80vh");
  });

  /**
   * pi 传进来的正文是**终端风格**文本（`──── Draft Details ────`、每行独立成行），
   * markdown 会把「单位换行」合并成空格 → 整段被压成一坨（用户截图那坨）。
   * 容器必须保留换行（whitespace-pre-wrap），markdown 结构照旧生效。
   */
  it("行结构保留：markdown 容器带 whitespace-pre-wrap", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r8",
      sessionId: "s1",
      method: "select",
      title: "──────── Draft Details ────────  |  Mode: Normal goal\n──────── Original Topic ────────\n**粗体**",
      options: ["甲"],
    });
    render(<ExtensionDialog sessionId="s1" />);

    const title = screen.getByTestId("ext-dialog-title");
    expect(title.className).toContain("whitespace-pre-wrap");
    // markdown 结构不能因此失效
    expect(title.querySelector("strong")?.textContent).toBe("粗体");
  });
});

describe("ExtensionDialog markdown 渲染", () => {
  /**
   * pi 传进来的长 prompt / message 就是 markdown（pi-goal-x 的草案还带 gfm 表格与列表）。
   * 当纯文本塞进段落里会被压成一坨（换行消失、** 与 | 原样露出），必须走和聊天同一套
   * markdown 管线（react-markdown + remark-gfm + createMarkdownComponents）。
   */
  const MD = [
    "## Draft Details",
    "",
    "**重点**：目标草案确认",
    "",
    "- 第一条",
    "- 第二条",
    "",
    "| 项 | 值 |",
    "| --- | --- |",
    "| Mode | Normal |",
  ].join("\n");

  it("标题按 markdown 渲染（标题/粗体/列表/表格都成真元素）", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r5",
      sessionId: "s1",
      method: "select",
      title: MD,
      options: ["甲"],
    });
    const { container } = render(<ExtensionDialog sessionId="s1" />);

    const title = screen.getByTestId("ext-dialog-title");
    expect(title.querySelector("h2")?.textContent).toBe("Draft Details");
    expect(title.querySelector("strong")?.textContent).toBe("重点");
    expect(title.querySelectorAll("li")).toHaveLength(2);
    expect(title.querySelector("table")).not.toBeNull();
    // 原始 markdown 记号不得原样露出
    expect(container.textContent).not.toContain("**重点**");
    expect(container.textContent).not.toContain("| --- |");
    // 高度契约不能被 markdown 破坏：标题区仍是限高自滚区
    expect(title.className).toContain("overflow-y-auto");
    expect(title.className).toMatch(/max-h-/);
  });

  it("message 同样按 markdown 渲染，且仍是滚动区", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r6",
      sessionId: "s1",
      method: "confirm",
      title: "确认",
      message: MD,
    });
    render(<ExtensionDialog sessionId="s1" />);

    const message = screen.getByTestId("ext-dialog-message");
    expect(message.querySelector("h2")?.textContent).toBe("Draft Details");
    expect(message.querySelectorAll("li")).toHaveLength(2);
    expect(message.className).toContain("overflow-y-auto");
    expect(message.className).toContain("min-h-0");
  });

  it("纯文本内容照旧（不因 markdown 管线变成空块或丢字）", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r7",
      sessionId: "s1",
      method: "select",
      title: "demo select：选一个",
      options: ["甲"],
    });
    render(<ExtensionDialog sessionId="s1" />);
    expect(screen.getByTestId("ext-dialog-title").textContent).toContain(
      "demo select：选一个",
    );
  });
});

describe("ExtensionDialog 高度约束", () => {
  it("正文区是唯一滚动区，选项区固定在按钮上方且不参与压缩", () => {
    seedSelect();
    render(<ExtensionDialog sessionId="s1" />);

    const message = screen.getByTestId("ext-dialog-message");
    expect(message.className).toContain("overflow-y-auto");
    expect(message.className).toContain("min-h-0");

    const actions = screen.getByTestId("ext-dialog-actions");
    // 决策区不可压缩：否则 flex 会把它压成一条缝（正文越长压得越狠）
    expect(actions.className).toContain("shrink-0");
    // 决策区不在滚动区里面：正文再长也推不走它
    expect(message.contains(actions)).toBe(false);
    // 选项按钮自身同样不可压缩
    for (const btn of screen.getAllByTestId("ext-dialog-option")) {
      expect(btn.className).toContain("shrink-0");
    }
    // 取消按钮仍在（唯一取消路径）
    expect(screen.getByTestId("ext-dialog-cancel")).toBeDefined();
  });

  /**
   * 真实形态：pi 的 select 把长长的 prompt 放在 **title**（截图里那坨几十行目标草案就是它），
   * message 反而是空的。头部不限高 → 卡片被撑满 → 选项与按钮被整个挤出卡片（卡片
   * overflow-hidden，用户连滚都滚不到）。头部必须限高自滚，决策区优先。
   */
  it("长标题（pi 的 select 就是这么传长 prompt）限高自滚，不挤走选项", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r4",
      sessionId: "s1",
      method: "select",
      title: LONG_MESSAGE,
      options: ["甲", "乙", "丙"],
    });
    render(<ExtensionDialog sessionId="s1" />);

    const title = screen.getByTestId("ext-dialog-title");
    expect(title.className).toContain("overflow-y-auto");
    expect(title.className).toMatch(/max-h-/);
    // 头部整行不可压缩 + ✕ 常驻
    expect(title.parentElement!.className).toContain("shrink-0");
    expect(screen.getByTestId("ext-dialog-close")).toBeDefined();
    // 选项与取消按钮都在（且不在标题区里）
    expect(screen.getByTestId("ext-dialog-options")).toBeDefined();
    expect(screen.getByTestId("ext-dialog-cancel")).toBeDefined();
    expect(title.contains(screen.getByTestId("ext-dialog-options"))).toBe(false);
  });

  it("选项列表超长时自己滚动，取消按钮仍留在卡片内", () => {
    seedSelect(Array.from({ length: 40 }, (_, i) => `选项 ${i + 1}`));
    render(<ExtensionDialog sessionId="s1" />);

    const list = screen.getByTestId("ext-dialog-options");
    expect(list.className).toContain("overflow-y-auto");
    expect(list.className).toMatch(/max-h-/);
    // 选项列表不是取消按钮的祖先：列表滚到底也不影响按钮位置
    expect(list.contains(screen.getByTestId("ext-dialog-cancel"))).toBe(false);
  });

  it("input/editor 同样不受长正文挤压（决策区固定可见）", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r2",
      sessionId: "s1",
      method: "editor",
      title: "demo editor",
      message: LONG_MESSAGE,
    });
    render(<ExtensionDialog sessionId="s1" />);

    const actions = screen.getByTestId("ext-dialog-actions");
    expect(actions.className).toContain("shrink-0");
    expect(
      actions.contains(screen.getByTestId("ext-dialog-editor")),
    ).toBe(true);
    expect(
      screen.getByTestId("ext-dialog-message").contains(actions),
    ).toBe(false);
  });
});

describe("ExtensionDialog 尺寸与行结构", () => {
  it("弹窗尺寸：宽 60%、高上限 80vh", () => {
    seedSelect();
    render(<ExtensionDialog sessionId="s1" />);

    const card = screen.getByTestId("ext-dialog") as HTMLElement;
    expect(card.style.width).toBe("60%");
    expect(card.style.maxHeight).toBe("80vh");
  });

  /**
   * pi 传进来的正文是**终端风格**文本（`──── Draft Details ────`、每行独立成行），
   * markdown 会把「单位换行」合并成空格 → 整段被压成一坨（用户截图那坨）。
   * 容器必须保留换行（whitespace-pre-wrap），markdown 结构照旧生效。
   */
  it("行结构保留：markdown 容器带 whitespace-pre-wrap", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r8",
      sessionId: "s1",
      method: "select",
      title: "──────── Draft Details ────────  |  Mode: Normal goal\n──────── Original Topic ────────\n**粗体**",
      options: ["甲"],
    });
    render(<ExtensionDialog sessionId="s1" />);

    const title = screen.getByTestId("ext-dialog-title");
    expect(title.className).toContain("whitespace-pre-wrap");
    // markdown 结构不能因此失效
    expect(title.querySelector("strong")?.textContent).toBe("粗体");
  });
});

describe("ExtensionDialog markdown 渲染", () => {
  /**
   * pi 传进来的长 prompt / message 就是 markdown（pi-goal-x 的草案还带 gfm 表格与列表）。
   * 当纯文本塞进段落里会被压成一坨（换行消失、** 与 | 原样露出），必须走和聊天同一套
   * markdown 管线（react-markdown + remark-gfm + createMarkdownComponents）。
   */
  const MD = [
    "## Draft Details",
    "",
    "**重点**：目标草案确认",
    "",
    "- 第一条",
    "- 第二条",
    "",
    "| 项 | 值 |",
    "| --- | --- |",
    "| Mode | Normal |",
  ].join("\n");

  it("标题按 markdown 渲染（标题/粗体/列表/表格都成真元素）", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r5",
      sessionId: "s1",
      method: "select",
      title: MD,
      options: ["甲"],
    });
    const { container } = render(<ExtensionDialog sessionId="s1" />);

    const title = screen.getByTestId("ext-dialog-title");
    expect(title.querySelector("h2")?.textContent).toBe("Draft Details");
    expect(title.querySelector("strong")?.textContent).toBe("重点");
    expect(title.querySelectorAll("li")).toHaveLength(2);
    expect(title.querySelector("table")).not.toBeNull();
    // 原始 markdown 记号不得原样露出
    expect(container.textContent).not.toContain("**重点**");
    expect(container.textContent).not.toContain("| --- |");
    // 高度契约不能被 markdown 破坏：标题区仍是限高自滚区
    expect(title.className).toContain("overflow-y-auto");
    expect(title.className).toMatch(/max-h-/);
  });

  it("message 同样按 markdown 渲染，且仍是滚动区", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r6",
      sessionId: "s1",
      method: "confirm",
      title: "确认",
      message: MD,
    });
    render(<ExtensionDialog sessionId="s1" />);

    const message = screen.getByTestId("ext-dialog-message");
    expect(message.querySelector("h2")?.textContent).toBe("Draft Details");
    expect(message.querySelectorAll("li")).toHaveLength(2);
    expect(message.className).toContain("overflow-y-auto");
    expect(message.className).toContain("min-h-0");
  });

  it("纯文本内容照旧（不因 markdown 管线变成空块或丢字）", () => {
    useExtDialogStore.getState().enqueue({
      requestId: "r7",
      sessionId: "s1",
      method: "select",
      title: "demo select：选一个",
      options: ["甲"],
    });
    render(<ExtensionDialog sessionId="s1" />);
    expect(screen.getByTestId("ext-dialog-title").textContent).toContain(
      "demo select：选一个",
    );
  });
});

