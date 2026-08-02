# 全角触发符归一化修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 Windows 中文输入法下输入全角符号（￥＄＠＃／）不触发技能/命令/智能体/文件弹窗的问题。

**架构：** 新增一个 `normalizeTriggerChars()` 纯函数，把「输入法可能产生的全角触发符符号」集中映射为半角等价物，在**检测路径**（`detectTrigger`）和**发送路径**（`expandTokens`）入口调用。显示路径（`textToSegments`/`textToHtml`）**不调用**，防止中文标点（（）、「」、［］等）被误归一化造成显示回归。

**根因（已由调查确认）：** 提交 `6ac4d693` 声称支持「全角 ¥」，但实际写入的正则字符是 U+00A5（YEN SIGN）。Windows 中文输入法在全角模式/选词时插入的是 U+FFE5（FULLWIDTH YEN SIGN），两个码点不同，正则无法匹配，导致 `detectTrigger` 返回 `null`、面板不弹出。同类问题波及命令触发符 `/`（不认全角 ／ U+FF0F）、智能体 `@`（不认 ＠ U+FF20）、文件 `#`（不认 ＃ U+FF03）。

**技术栈：** TypeScript、bun:test（单元测试）、Vitest + @testing-library/react（组件测试）、Playwright（E2E）

---

## 文件结构

**修改文件：**
- `packages/frontend/src/quick-invoke/tokens.ts` — 新增 `normalizeTriggerChars()` 导出；`expandTokens()` 入口调用
- `packages/frontend/src/quick-invoke/trigger.ts` — `detectTrigger()` 入口调用 `normalizeTriggerChars()`
- `packages/frontend/tests/tokens.test.ts` — 新增 normalize + expandTokens 全角用例
- `packages/frontend/tests/trigger.test.ts` — 新增全角触发符检测用例
- `packages/frontend/tests/ComposerInput.test.tsx` — 新增「输入全角 ￥ 触发技能面板」组件用例
- `packages/frontend/e2e/quick-invoke.spec.ts` — 新增「输入全角 ￥ 触发技能面板」E2E 用例
- `CHANGELOG.md`（仓库根目录）— 顶部新增变更条目

**不改动：** `textToSegments` / `textToHtml` / `segmentsToText`（显示路径，保持只认半角 token，防止中文标点回归）；`SKILL_TOKEN_RE` / `COMMAND_TOKEN_RE` 等 token 正则本身（保持半角，归一化在入口完成）。

## 全局约束（所有任务必须遵守）

1. **归一化映射表只含 5 个触发符符号**：U+FFE5→U+00A5（￥→¥）、U+FF04→$（＄）、U+FF20→@（＠）、U+FF03→#（＃）、U+FF0F→/（／）。**绝不映射全角字母数字（ＡＢＣ０１２３）和全角标点（（）、「」、［］等）**——那些是中文正常内容。
2. **测试代码里 U+FFE5 一律写 `"\uFFE5"` 转义**（禁止写字面量「￥」，避免与 U+00A5「¥」肉眼混淆）；U+00A5 保持字面量「¥」或 `"\u00A5"`。
3. 显示路径（textToSegments/textToHtml）不归一化——全角 token 在 UI 显示为纯文本是**预期行为**，不要改。
4. 发送路径（expandTokens）归一化后，普通文本中的全角触发符符号变为半角（如「￥500」→「¥500」）——语义等价，**预期行为**，测试锁定。
5. 每个任务遵循 TDD：先写失败测试 → 跑失败 → 实现 → 跑通过 → commit。
6. 中文注释、中文 commit message。

---

### 任务 1：normalizeTriggerChars 纯函数 + detectTrigger/expandTokens 集成 + 单元测试

**文件：**
- 修改：`packages/frontend/src/quick-invoke/tokens.ts`
- 修改：`packages/frontend/src/quick-invoke/trigger.ts`
- 测试：`packages/frontend/tests/tokens.test.ts`
- 测试：`packages/frontend/tests/trigger.test.ts`

- [ ] **步骤 1：编写失败的单元测试**

在 `packages/frontend/tests/tokens.test.ts` 顶部 import 处加入 `normalizeTriggerChars`：

```ts
import {
  FILE_TOKEN_RE, SKILL_TOKEN_RE, AGENT_TOKEN_RE,
  expandTokens, textToSegments, segmentsToText, textToHtml, escapeHtml,
  registerAgentMeta, clearAgentMeta, normalizeTriggerChars,
} from "../src/quick-invoke/tokens";
```

在该文件末尾（`afterEach(clearAgentMeta)` 之后）追加以下用例：

```ts
// ===== 全角触发符归一化（Windows 输入法全角模式修复）=====
// 根因：代码匹配 U+00A5（¥），Windows 中文输入法插入 U+FFE5（￥），码点不同导致不触发。
// normalizeTriggerChars 把全角触发符符号集中映射为半角，检测/发送路径入口调用。

test("normalizeTriggerChars 把全角触发符符号归一化为半角", () => {
  expect(normalizeTriggerChars("用 ￥brain ＄x ＠y ＃z ／w")).toBe("用 ¥brain $x @y #z /w");
});

test("normalizeTriggerChars 不动全角字母数字和中文标点（防止显示/内容回归）", () => {
  expect(normalizeTriggerChars("ＡＢＣ１２３（中文）「引号」［括号］")).toBe("ＡＢＣ１２３（中文）「引号」［括号］");
});

test("expandTokens 展开全角 ￥ token（U+FFE5）为 /skill:name", () => {
  expect(expandTokens("用 \uFFE5[brainstorming] 技能")).toBe("用 /skill:brainstorming  技能");
});

test("expandTokens 展开全角 ／ token（U+FF0F）为 /cmd", () => {
  expect(expandTokens("\uFF0F[my-command] 执行")).toBe("/my-command  执行");
});

test("expandTokens 发送时把普通文本中的全角触发符符号归一化为半角（语义等价，预期行为）", () => {
  expect(expandTokens("价格 ￥500 和 ＠mention")).toBe("价格 ¥500 和 @mention");
});
```

在 `packages/frontend/tests/trigger.test.ts` 末尾追加以下用例：

```ts
// ===== 全角触发符（Windows 输入法全角模式插入 U+FFE5 等，需归一化后触发）=====

test("detectTrigger 全角 ￥（U+FFE5）触发技能面板", () => {
  const result = detectTrigger("用 \uFFE5brain");
  expect(result).toEqual({ type: "skill", query: "brain" });
});

test("detectTrigger 全角 ＄（U+FF04）触发技能面板", () => {
  const result = detectTrigger("用 \uFF04brain");
  expect(result).toEqual({ type: "skill", query: "brain" });
});

test("detectTrigger 全角 ＠（U+FF20）触发智能体面板", () => {
  const result = detectTrigger("hello \uFF20审");
  expect(result).toEqual({ type: "agent", query: "审" });
});

test("detectTrigger 全角 ＃（U+FF03）触发文件面板", () => {
  const result = detectTrigger("打开 \uFF03src/comp");
  expect(result).toEqual({ type: "file", query: "src/comp" });
});

test("detectTrigger 全角 ／（U+FF0F）触发命令面板", () => {
  const result = detectTrigger("text \uFF0Fcmd");
  expect(result).toEqual({ type: "command", query: "cmd" });
});

test("detectTrigger 全角 chip token 不触发（归一化后按已存在 token 清洗）", () => {
  expect(detectTrigger("\uFFE5[skill] 你好")).toBeNull();
});

test("detectTrigger 全角符号在文本中间不触发（需行首或空格之后）", () => {
  expect(detectTrigger("email\uFF20test")).toBeNull();
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd packages/frontend && bun test tests/tokens.test.ts tests/trigger.test.ts 2>&1 | tail -30
```

预期：新增用例 FAIL（`normalizeTriggerChars is not defined` / 全角字符返回 `null` 而非期望对象）。

- [ ] **步骤 3：实现 normalizeTriggerChars + 集成**

在 `packages/frontend/src/quick-invoke/tokens.ts` 顶部（`AGENT_TOKEN_RE` 常量定义之前）新增：

```ts
/**
 * 全角触发符符号 → 半角映射表。
 *
 * 背景：Windows 中文输入法在全角模式下插入的是全角符号（如 ￥ U+FFE5），
 * 而代码里匹配的是半角 U+00A5。该映射把输入法可能产生的全角触发符
 * 统一归一化为代码认识的半角等价物，使 $/¥/￥、@/＠、#/＃、//／ 都能触发对应面板。
 *
 * 注意：只映射「触发符相关符号」，绝不动全角字母数字（ＡＢＣ０１２３）和
 * 中文标点（（）、「」、［］等）——那些在中文文本里是正常内容，归一化会造成回归。
 */
const FULLWIDTH_TRIGGER_MAP: Record<string, string> = {
  "\uFFE5": "\u00A5", // ￥ (FULLWIDTH YEN SIGN) → ¥ (YEN SIGN)
  "\uFF04": "$",       // ＄ (FULLWIDTH DOLLAR SIGN) → $
  "\uFF20": "@",       // ＠ (FULLWIDTH COMMERCIAL AT) → @
  "\uFF03": "#",       // ＃ (FULLWIDTH NUMBER SIGN) → #
  "\uFF0F": "/",       // ／ (FULLWIDTH SOLIDUS) → /
};

/** 把全角触发符符号归一化为半角（检测/发送路径入口调用；显示路径不调用）。 */
export function normalizeTriggerChars(text: string): string {
  return text.replace(/[\uFFE5\uFF04\uFF20\uFF03\uFF0F]/g, ch => FULLWIDTH_TRIGGER_MAP[ch]);
}
```

修改 `expandTokens`（同文件），入口先归一化：

```ts
export function expandTokens(text: string): string {
  return normalizeTriggerChars(text)
    .replace(FILE_TOKEN_RE, "#$1")
    .replace(SKILL_TOKEN_RE, "/skill:$1 ") // 末尾空格：SDK _expandSkillCommand 用空格分隔技能名和参数
    .replace(COMMAND_TOKEN_RE, "/$1 ");  // 命令 chip 展开为 /命令名 ，pi 识别为斜杠命令
}
```

在 `packages/frontend/src/quick-invoke/trigger.ts` 顶部 import：

```ts
import { normalizeTriggerChars } from "./tokens";
```

修改 `detectTrigger`（同文件），入口先归一化，后续全部用归一化后的文本：

```ts
export function detectTrigger(text: string): TriggerResult | null {
  // 全角触发符（￥＄＠＃／）先归一化为半角，再走既有检测逻辑
  // （Windows 输入法全角模式插入 U+FFE5，而代码匹配 U+00A5）
  const normalized = normalizeTriggerChars(text);

  // 先移除已存在的 chip token，避免 token 内的触发符干扰检测
  const cleaned = normalized
    .replace(/@\[[^\]]+\]/g, " ")
    .replace(/#\[[^\]]+\]/g, " ")
    .replace(/\$\[[^\]]+\]/g, " ")
    .replace(/¥\[[^\]]+\]/g, " ");
  // ...（后续 @/#/$// 检测逻辑不变，用 cleaned）
}
```

注意：`detectTrigger` 内其余逻辑（atMatch/hashMatch/dollarMatch/slashMatch、`filterItems`）**保持原样**，只是把局部变量 `text` 换为 `normalized`。

- [ ] **步骤 4：运行测试验证通过**

```bash
cd packages/frontend && bun test tests/tokens.test.ts tests/trigger.test.ts 2>&1 | tail -30
```

预期：全部 PASS（含原有用例——确保未破坏既有行为）。

- [ ] **步骤 5：类型检查 + 提交**

```bash
cd packages/frontend && bun run typecheck 2>&1 | tail -20
```

预期：无类型错误。

```bash
cd /h/workspace/hiagent/.worktrees/fix-fullwidth-trigger-normalize
git add packages/frontend/src/quick-invoke/tokens.ts packages/frontend/src/quick-invoke/trigger.ts packages/frontend/tests/tokens.test.ts packages/frontend/tests/trigger.test.ts
git commit -m "fix(frontend): 触发符支持全角符号（￥＄＠＃／ 归一化），修复 Windows 输入 ￥ 不弹技能面板"
```

---

### 任务 2：组件测试 + E2E

**文件：**
- 测试：`packages/frontend/tests/ComposerInput.test.tsx`
- 测试：`packages/frontend/e2e/quick-invoke.spec.ts`

- [ ] **步骤 1：编写失败的组件测试**

在 `packages/frontend/tests/ComposerInput.test.tsx` 中，紧跟在现有「输入 $ 触发技能面板」用例（`test("输入 $ 触发技能面板"`，约第 364 行）之后新增：

```tsx
test("输入全角 ￥（U+FFE5）触发技能面板（Windows 中文输入法场景）", () => {
  useSkillsStore.setState({
    allSkills: [
      { name: "brainstorming", description: "头脑风暴", path: "/skills/brain", source: { type: "builtin" } },
    ],
    skills: [],
    dirs: [],
    disabledSkills: [],
    builtinDir: "",
  });
  renderComposer({ text: "用 \uFFE5brain" });
  expect(screen.getByText("brainstorming")).toBeDefined();
});
```

先确认现有「输入 $ 触发技能面板」用例的 setup 写法（`useSkillsStore.setState` 的内容、`renderComposer` 的调用签名），若与本骨架有出入，以现有用例为准保持一致。

- [ ] **步骤 2：运行组件测试验证失败**

```bash
cd packages/frontend && bun test tests/ComposerInput.test.tsx 2>&1 | tail -30
```

预期：新增用例 FAIL（面板未弹出，`brainstorming` 不存在）。

- [ ] **步骤 3：运行全部前端单元+组件测试确认通过**

此时任务 1 的归一化已合入，组件测试应转绿：

```bash
cd packages/frontend && bun test 2>&1 | tail -20
```

预期：全部 PASS。

- [ ] **步骤 4：新增 E2E 用例**

在 `packages/frontend/e2e/quick-invoke.spec.ts` 中，紧跟在现有「输入 $ 选技能 → chip 显示 → 发送时展开」用例之后新增（复用该用例的技能预置 setup，参考其 `skillDirRoot` / `addSkillDir` / `enterSession` 写法）：

```ts
test("输入全角 ￥（U+FFE5）触发技能面板", async ({ page }) => {
  // 预置技能（与 $ 用例相同的 setup：REST addSkillDir + SSE 回推）
  const skillDirRoot = join(process.env.HOME || "/tmp", `.wa-pi-e2e-quick-invoke-skills-${randomUUID().slice(0, 8)}`);
  const skillPkgDir = join(skillDirRoot, "e2e-qi-skill");
  mkdirSync(skillPkgDir, { recursive: true });
  writeFileSync(
    join(skillPkgDir, "SKILL.md"),
    "---\nname: e2e-qi-skill\ndescription: E2E Quick Invoke 测试技能\n---\n# e2e-qi-skill\n测试用",
    "utf8",
  );

  try {
    await addSkillDir(skillDirRoot);
    await enterSession(page, "发起技能会话");

    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');

    // 1. 输入全角 ￥（Playwright 对 Unicode 字符走 insertText，模拟输入法插入 U+FFE5）
    await textbox.click();
    await page.keyboard.type("\uFFE5", { delay: 5 });

    // 2. 等待技能面板出现
    await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({ timeout: 5000 });

    // 3. 输入技能名过滤并断言技能项出现
    await page.keyboard.type("e2e-qi", { delay: 10 });
    await expect(page.getByTestId("quick-invoke-menu")).toContainText("e2e-qi-skill", { timeout: 8000 });
  } finally {
    if (existsSync(skillDirRoot)) rmSync(skillDirRoot, { recursive: true, force: true });
  }
});
```

注意：该 spec 是 `test.describe.serial` 串行套件，新用例插在中间位置即可（不依赖顺序）。

- [ ] **步骤 5：跑 E2E（若环境可启动）**

```bash
cd packages/frontend && bun run test:e2e -- --grep "输入全角" 2>&1 | tail -30
```

若项目没有 `test:e2e` script 或 E2E 需要额外启动（见 `package.json` / e2e 目录说明），按项目既有方式运行 `quick-invoke.spec.ts`。若 E2E 环境无法在当前环境启动，在报告中注明「E2E 未运行，已提供用例待 CI 执行」，并在报告中附上你为确认用例可编译而做的类型检查结果。

- [ ] **步骤 6：提交**

```bash
cd /h/workspace/hiagent/.worktrees/fix-fullwidth-trigger-normalize
git add packages/frontend/tests/ComposerInput.test.tsx packages/frontend/e2e/quick-invoke.spec.ts
git commit -m "test(frontend): 覆盖全角 ￥ 触发技能面板（组件测试 + E2E）"
```

---

### 任务 3：CHANGELOG + 全量回归

**文件：**
- 修改：`CHANGELOG.md`（仓库根目录）

- [ ] **步骤 1：更新 CHANGELOG**

在根目录 `CHANGELOG.md` **顶部**（按现有条目格式，时间倒序）新增：

```markdown
## 2026-08-02

### 修复
- fix(frontend): 技能/命令/智能体/文件触发符支持全角符号（￥＄＠＃／ 归一化）——Windows 中文输入法全角模式输入 ￥ 不再失效
```

先看现有 `CHANGELOG.md` 顶部格式，若格式不同（如日期标题级别、分组标题），按现有格式对齐。

- [ ] **步骤 2：全量回归**

```bash
cd /h/workspace/hiagent/.worktrees/fix-fullwidth-trigger-normalize
bun run test 2>&1 | tail -30
```

预期：kernel / shared / desktop / frontend 全部 PASS。

- [ ] **步骤 3：提交**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录全角触发符归一化修复"
```

---

## 自检清单

- [ ] 映射表只含 5 个触发符符号，不含全角字母数字/标点
- [ ] detectTrigger / expandTokens 入口调用 normalizeTriggerChars，其余逻辑不变
- [ ] textToSegments / textToHtml / segmentsToText 未改动（显示路径不归一化）
- [ ] 单元测试覆盖：5 个全角符号触发 + 普通文本不动 + 全角 token 展开 + 全角 token 不误触发
- [ ] 组件测试覆盖：输入 \uFFE5 弹技能面板
- [ ] E2E 覆盖：输入 \uFFE5 弹技能面板（或注明待 CI）
- [ ] CHANGELOG 已更新
- [ ] 全量测试通过
