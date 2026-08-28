import { test, expect, afterEach } from "bun:test";
import {
  FILE_TOKEN_RE,
  SKILL_TOKEN_RE,
  AGENT_TOKEN_RE,
  expandTokens,
  textToSegments,
  segmentsToText,
  textToHtml,
  escapeHtml,
  registerAgentMeta,
  clearAgentMeta,
  normalizeTriggerChars,
  selectionToTokenText,
} from "../src/quick-invoke/tokens";

test("expandTokens 展开文件 token（#[path] -> #path）", () => {
  expect(expandTokens("看这个 #[packages/App.tsx] 文件")).toBe(
    "看这个 #packages/App.tsx 文件",
  );
});

test("expandTokens 展开技能 token 为 /skill:name + 空格（SDK _expandSkillCommand 用空格分隔技能名和参数）", () => {
  expect(expandTokens("用 $[brainstorming] 技能")).toBe(
    "用 /skill:brainstorming  技能",
  );
  expect(expandTokens("用 ¥[brainstorming] 技能")).toBe(
    "用 /skill:brainstorming  技能",
  );
});

test("expandTokens 技能后紧跟用户文字时加空格分隔", () => {
  expect(expandTokens("$[tencent-docs]帮我看看文档")).toBe(
    "/skill:tencent-docs 帮我看看文档",
  );
});

test("expandTokens 同时展开文件和技能 token", () => {
  expect(expandTokens("#[a.tsx] 和 $[my-skill]")).toBe(
    "#a.tsx 和 /skill:my-skill ",
  );
});

test("expandTokens 不处理 agent token（@[xxx] 原样保留给主智能体识别）", () => {
  expect(expandTokens("@[代码审查] 帮我看看")).toBe("@[代码审查] 帮我看看");
});

test("expandTokens 无 token 时原样返回", () => {
  expect(expandTokens("普通文本")).toBe("普通文本");
});

test("textToSegments 拆分文本和文件 chip（#[]）", () => {
  const segs = textToSegments("hello #[file.ts] world");
  expect(segs).toEqual([
    { type: "text", value: "hello " },
    { type: "file", value: "file.ts" },
    { type: "text", value: " world" },
  ]);
});

test("textToSegments 识别技能 chip", () => {
  expect(textToSegments("$[my-skill]")).toEqual([
    { type: "skill", value: "my-skill" },
  ]);
  expect(textToSegments("¥[my-skill]")).toEqual([
    { type: "skill", value: "my-skill" },
  ]);
});

test("textToSegments 识别 agent chip（@[]）", () => {
  const segs = textToSegments("@[代码审查] 帮我看看");
  expect(segs).toEqual([
    { type: "agent", value: "代码审查" },
    { type: "text", value: " 帮我看看" },
  ]);
});

test("segmentsToText 与 textToSegments 可逆", () => {
  const original = "看 #[a.ts] 和 $[skill] 加 @[pm]";
  expect(segmentsToText(textToSegments(original))).toBe(original);
  // ¥[skill] 代入内部统一为 $[skill]（segmentsToText 写 $ token）
  expect(segmentsToText(textToSegments("用 ¥[skill] 技能"))).toBe(
    "用 $[skill] 技能",
  );
});

test("escapeHtml 转义 HTML 特殊字符", () => {
  expect(escapeHtml("<script>alert(1)</script>")).toBe(
    "&lt;script&gt;alert(1)&lt;/script&gt;",
  );
});

test("textToHtml 渲染文件 chip 为 span", () => {
  const html = textToHtml("#[App.tsx]");
  expect(html).toContain('data-token="#[App.tsx]"');
  expect(html).toContain("#App.tsx");
  expect(html).toContain("chip-file");
});

test("textToHtml 文件 chip 只显示文件名（path: 前缀+目录裁掉），data-token 保留完整路径", () => {
  // 拖拽引用 #[path:绝对路径]：显示文件名，data-token 保留完整引用
  const html = textToHtml("#[path:/tmp/proj/a.ts]");
  expect(html).toContain('data-token="#[path:/tmp/proj/a.ts]"');
  expect(html).toContain(">#a.ts</span>");
  expect(html).toContain("chip-file");
  // @ 面板相对路径同样只显示文件名
  const html2 = textToHtml("#[packages/App.tsx]");
  expect(html2).toContain('data-token="#[packages/App.tsx]"');
  expect(html2).toContain(">#App.tsx</span>");
});

test("textToHtml 渲染技能 chip 为 span", () => {
  // 技能 chip 的闪电图标已由 Unicode ⚡ 改为内联 svg（iconSvg("bolt")），
  // 故只断言 svg 标记 + 技能名 + class，不再断言 ⚡ 字面量。
  expect(textToHtml("$[brainstorm]")).toContain('data-token="$[brainstorm]"');
  expect(textToHtml("$[brainstorm]")).toContain("<svg");
  expect(textToHtml("$[brainstorm]")).toContain("> brainstorm</span>");
  expect(textToHtml("$[brainstorm]")).toContain("chip-skill");
  // ¥ token 渲染时 chip 同样用 svg 闪电（内部统一表示）
  expect(textToHtml("¥[brainstorm]")).toContain('data-token="$[brainstorm]"');
  expect(textToHtml("¥[brainstorm]")).toContain("<svg");
  expect(textToHtml("¥[brainstorm]")).toContain("> brainstorm</span>");
  expect(textToHtml("¥[brainstorm]")).toContain("chip-skill");
});

test("textToHtml 渲染 agent chip 为 span（chip-agent 蓝色，含 @ 触发符）", () => {
  const html = textToHtml("@[代码审查]");
  expect(html).toContain('data-token="@[代码审查]"');
  expect(html).toContain("@代码审查");
  expect(html).toContain("chip-agent");
});

test("textToHtml agent chip 的 @ 在 avatar 之前（最前面）", () => {
  // 用户期望：@某人 → @ 在 icon 之前，不在 icon 和名字之间
  registerAgentMeta("代码审查", { avatar: "🔍", avatarColor: "#0891b2" });
  const html = textToHtml("@[代码审查]");
  // chip-agent 内部结构：@ + avatar span + name
  // @ 必须出现在 avatar 之前（用 ">@" 精准定位触发符 @，避免匹配到 data-token 属性中的 @）
  const atIdx = html.indexOf(">@") + 1; // +1 跳过 > 定位到 @ 本身
  const avatarIdx = html.indexOf("chip-agent-avatar");
  expect(atIdx).toBeGreaterThanOrEqual(0);
  expect(avatarIdx).toBeGreaterThan(atIdx);
  // 头像 emoji 在 @ 之后、name 之前
  const emojiIdx = html.indexOf("🔍");
  const nameIdx = html.indexOf("代码审查", avatarIdx);
  expect(emojiIdx).toBeGreaterThan(atIdx);
  expect(nameIdx).toBeGreaterThan(emojiIdx);
});

test("textToHtml agent chip：内置 subagent data-token 存英文但显示中文 displayName", () => {
  // 内置 subagent 的 token 用英文 name（@[Plan]），但 chip 显示中文（规划子智能体）。
  // registerAgentMeta 传入 displayName 让 textToHtml 用中文渲染。
  registerAgentMeta("Plan", {
    avatar: "📐",
    avatarColor: "#7c3aed",
    displayName: "规划子智能体",
  });
  const html = textToHtml("@[Plan]");
  // data-token 存英文 token（发后端用）
  expect(html).toContain('data-token="@[Plan]"');
  // 显示文本是中文（给用户看）
  expect(html).toContain("规划子智能体");
  // 不能出现裸英文 name 作为显示文本（avatar 标签里的除外）
  expect(html).not.toContain(">Plan<");
});

afterEach(clearAgentMeta);

test("textToHtml 传 { hideTrigger: true } 时 agent chip 不含 @ 前缀（仅展示名，用于历史消息渲染）", () => {
  const html = textToHtml("@[代码审查]", { hideTrigger: true });
  // data-token 保留完整 token（重建文本用）
  expect(html).toContain('data-token="@[代码审查]"');
  // 显示文本不含 @（与 ComposerTextarea 输入框区分：输入保留 @ 让用户看到触发符，展示去 @ 更干净）
  expect(html).toContain(">代码审查<");
  expect(html).not.toContain("@代码审查");
  expect(html).toContain("chip-agent");
});

test("textToHtml 转义普通文本中的 HTML", () => {
  const html = textToHtml("<b>bold</b>");
  expect(html).toBe("&lt;b&gt;bold&lt;/b&gt;");
});

// ===== 换行保留：渲染侧根因复现 =====
// 用户消息（MessageList isUser 分支）用 textToHtml 渲染。
// 若 textToHtml 把 \n 丢成空格，多行消息发送后显示成一行。
// 要求：textToHtml 把普通文本段里的 \n 转为 <br>，
// 这样不依赖外层 white-space 即可正确显示换行。

test("textToHtml 保留换行：普通文本多行 → \\n 转为 <br>", () => {
  const html = textToHtml("第一行\n第二行");
  expect(html).toBe("第一行<br>第二行");
});

test("textToHtml 保留换行：chip 前后跨行，chip 内部不误转", () => {
  const html = textToHtml("第一行\n#[App.tsx]\n第二行");
  expect(html).toBe(
    '第一行<br><span class="chip chip-file" contenteditable="false" data-token="#[App.tsx]">#App.tsx</span><br>第二行',
  );
});

// ===== 全角触发符归一化（Windows 输入法全角模式修复）=====
// 根因：代码匹配 U+00A5（¥），Windows 中文输入法插入 U+FFE5（￥），码点不同导致不触发。
// normalizeTriggerChars 把全角触发符符号集中映射为半角，检测/发送路径入口调用。

test("normalizeTriggerChars 把全角触发符符号归一化为半角", () => {
  expect(
    normalizeTriggerChars("用 \uFFE5brain \uFF04x \uFF20y \uFF03z \uFF0Fw"),
  ).toBe("用 ¥brain $x @y #z /w");
});

test("normalizeTriggerChars 不动全角字母数字和中文标点（防止显示/内容回归）", () => {
  expect(normalizeTriggerChars("ＡＢＣ１２３（中文）「引号」［括号］")).toBe(
    "ＡＢＣ１２３（中文）「引号」［括号］",
  );
});

test("expandTokens 展开全角 ￥ token（U+FFE5）为 /skill:name", () => {
  expect(expandTokens("用 \uFFE5[brainstorming] 技能")).toBe(
    "用 /skill:brainstorming  技能",
  );
});

test("expandTokens 展开全角 ／ token（U+FF0F）为 /cmd", () => {
  expect(expandTokens("\uFF0F[my-command] 执行")).toBe("/my-command  执行");
});

test("expandTokens 发送时把普通文本中的全角触发符符号归一化为半角（语义等价，预期行为）", () => {
  expect(expandTokens("价格 \uFFE5500 和 \uFF20mention")).toBe(
    "价格 ¥500 和 @mention",
  );
});

test("expandTokens 展开命令 token（/[/compact] -> /compact 空格）", () => {
  expect(expandTokens("/[compact] 只保留关键决策")).toBe(
    "/compact  只保留关键决策",
  );
  expect(expandTokens("/[compact]")).toBe("/compact ");
});

// ── selectionToTokenText：复制时 chip → token 原文 ──

test("selectionToTokenText：选中单个 chip 输出 token 原文而非显示文本", () => {
  document.body.innerHTML = `<div contenteditable="true">看 <span class="chip" data-token="$[日报生成]" contenteditable="false">⚡ 日报生成</span> 这个</div>`;
  const chip = document.querySelector("[data-token]") as HTMLElement;
  const range = document.createRange();
  range.selectNode(chip);
  expect(selectionToTokenText(range)).toBe("$[日报生成]");
});

test("selectionToTokenText：chip 内原子选区（user-select:all）也输出完整 token", () => {
  document.body.innerHTML = `<div contenteditable="true">看 <span class="chip" data-token="$[日报生成]" contenteditable="false">⚡ 日报生成</span> 这个</div>`;
  // 模拟点击 chip 全选后复制：range 落在 chip 文本子节点内
  const chip = document.querySelector("[data-token]") as HTMLElement;
  const textNode = chip.firstChild as Text;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, 2);
  expect(selectionToTokenText(range)).toBe("$[日报生成]");
});

test("selectionToTokenText：多类型 chip 与文本混合输出 token 原文", () => {
  document.body.innerHTML = `<div contenteditable="true">a <span data-token="@[Plan]">@规划子智能体</span> b <span data-token="/[compact]">/compact</span> c</div>`;
  const div = document.querySelector("div") as HTMLElement;
  const range = document.createRange();
  range.selectNodeContents(div);
  expect(selectionToTokenText(range)).toBe("a @[Plan] b /[compact] c");
});

test("selectionToTokenText：选中普通文本无 chip 时原样输出", () => {
  document.body.innerHTML = `<div contenteditable="true">普通文本内容</div>`;
  const div = document.querySelector("div") as HTMLElement;
  const range = document.createRange();
  range.selectNodeContents(div);
  expect(selectionToTokenText(range)).toBe("普通文本内容");
});
