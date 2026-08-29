import { test, expect, afterEach } from "bun:test";
import {
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

test("expandTokens 展开文件 token（统一带 path: 锚）", () => {
  expect(expandTokens("看这个 #[packages/App.tsx] 文件")).toBe(
    "看这个 #path:packages/App.tsx 文件",
  );
  // 拖拽插入的已带 path: 前缀 → 不重复
  expect(expandTokens("看 #[path:/abs/dir] 目录")).toBe(
    "看 #path:/abs/dir 目录",
  );
  // 纯数字文件夹名也支持
  expect(expandTokens("#[2024]")).toBe("#path:2024");
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
    "#path:a.tsx 和 /skill:my-skill ",
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

// ── expandedTextToHtml：展开形态还原 + chip 渲染（排队队列面板场景）──

import {
  expandedTextToHtml,
  ensureChipStyles,
  restoreFilePathTokens,
} from "../src/quick-invoke/tokens";

test("expandedTextToHtml：/skill:name 还原为技能 chip（knownSkills 命中）", () => {
  const html = expandedTextToHtml("先 /skill:brainstorm  再继续", {
    knownSkills: new Set(["brainstorm"]),
  });
  expect(html).toContain('class="chip chip-skill"');
  expect(html).toContain("brainstorm");
  expect(html).not.toContain("/skill:brainstorm");
});

test("expandedTextToHtml：knownSkills 未命中的 /skill:x 保持原样（防任意文本误判）", () => {
  const html = expandedTextToHtml("跑 /skill:not-a-skill 看看", {
    knownSkills: new Set(["brainstorm"]),
  });
  expect(html).not.toContain("chip-skill");
  expect(html).toContain("/skill:not-a-skill");
});

test("expandedTextToHtml：#path: 锚还原为文件 chip（零误判，含纯数字文件夹名）", () => {
  const html = expandedTextToHtml(
    "看 #path:packages/App.tsx 和 #path:README.md 和 #path:2024",
    {},
  );
  expect((html.match(/class="chip chip-file"/g) ?? []).length).toBe(3);
  // data-token 保留完整路径
  expect(html).toContain('data-token="#[path:packages/App.tsx]"');
  expect(html).toContain('data-token="#[path:README.md]"');
  expect(html).toContain('data-token="#[path:2024]"');
});

test("expandedTextToHtml：裸 #词（无 path: 锚）不还原（零误判取舍）", () => {
  // #docs、#1、# 标题 均非文件引用形态——文件引用请走 #[x] token（展开后自动带锚）
  const html = expandedTextToHtml("整理 #docs，问题 #1 和 # 标题", {});
  expect(html).not.toContain("chip-file");
  expect(html).toContain("#docs");
  expect(html).toContain("#1");
});

test("expandedTextToHtml：原样 token 形态 #[x] 不重复还原（负向前瞻）", () => {
  const html = expandedTextToHtml("看 #[App.tsx]", {});
  // textToHtml 本身识别 #[x] 原样形态 → 仍渲染为 chip，且不会出现 [[x]]
  expect(html).toContain('class="chip chip-file"');
  expect(html).not.toContain("[[");
});

test("expandedTextToHtml：agent chip 支持 hideTrigger，element 展开形态原生识别", () => {
  const html = expandedTextToHtml("@[Plan] 看样式 [line: 1-2] [el: div.card]", {
    hideTrigger: true,
  });
  expect(html).toContain("chip-agent");
  expect(html).not.toContain(">@");
  expect(html).toContain("chip-element");
});

test("expandedTextToHtml：普通文本经 escapeHtml 转义（防注入）", () => {
  const html = expandedTextToHtml(
    "<img src=x onerror=alert(1)> #path:a.txt",
    {},
  );
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img");
  expect(html).toContain("chip-file");
});

// ── restoreFilePathTokens：file 锚还原（聊天窗/排队区共享）──

test("restoreFilePathTokens：#path: 锚还原为 #[path:x]（含纯数字目录名）", () => {
  expect(restoreFilePathTokens("看 #path:src/App.tsx 和 #path:2024")).toBe(
    "看 #[path:src/App.tsx] 和 #[path:2024]",
  );
});

test("restoreFilePathTokens：裸 #词与已还原形态不误伤", () => {
  // 裸 #词不是文件引用，不猜；#[path:x] 中 # 后是 [ 不匹配锚，不重复包里
  expect(restoreFilePathTokens("整理 #docs 和 #1，见 #[path:a.ts]")).toBe(
    "整理 #docs 和 #1，见 #[path:a.ts]",
  );
});

test("expandedTextToHtml：chip 渲染需要 ensureChipStyles 样式已注入（幂等）", () => {
  ensureChipStyles();
  ensureChipStyles(); // 多次调用安全
  // 仅验证不抛异常（样式注入属 DOM 副作用，chip class 断言在上面的用例覆盖）
});
