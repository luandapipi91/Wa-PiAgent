# 模型供应商预设（快捷选择）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有「添加 / 编辑供应商」表单顶部新增「快捷选择」下拉，内置 10 条主流供应商预设；选中后自动填入名称 / Base URL / 协议 / 模型列表（apiKey 仍需手填），所有字段填入后仍可编辑。

**Architecture:** 新增纯常量模块 `packages/shared/src/provider-presets.ts`（`PROVIDER_PRESETS` 数组 + `ProviderPreset` 类型），从 `@wa-pi/shared` 导出。仅修改前端 `ProviderFormModal.tsx`：顶部加原生 `<select>`，`onChange` 把预设字段映射进既有表单 state（**不走** `handleTagsChange`，以免把预设真实数值套成默认 128000/4096）。后端、类型、WS 协议、持久化格式零改动 —— 预设选中后保存出的对象与手填供应商完全同构。

**Tech Stack:** TypeScript、React 19、原生 `<select>`、bun:test（单元 + 组件）、@testing-library/react + happy-dom（组件）、Playwright（E2E）、Zustand（store）。

**Spec:** [docs/superpowers/specs/2026-07-10-provider-presets-design.md](../specs/2026-07-10-provider-presets-design.md)（已确认）

---

## 开始前

- **分支隔离**：若直接在 master 上实现，先开分支 `git switch -c feat/provider-presets`；若通过 worktree 隔离执行，则跳过此步（worktree 自带分支）。
- 本计划**不修改后端**。任何对 `provider-store.ts` / `provider-extension.ts` / `provider-test.ts` / `providers.ts` / `types.ts` 的改动都属越界，需回退。
- 所有回复使用中文（AGENTS.md）。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `packages/shared/src/provider-presets.ts` | 预设类型 `ProviderPreset` + 常量 `PROVIDER_PRESETS`（10 条） | 新建 |
| `packages/shared/src/index.ts` | 统一导出；加 `export * from "./provider-presets"` | 改 |
| `packages/shared/tests/provider-presets.test.ts` | 预置数据完整性单元测试 | 新建 |
| `packages/frontend/src/components/settings/ProviderFormModal.tsx` | 顶部 `<select>` + `applyPreset` + hint + 编辑模式提示 | 改 |
| `packages/frontend/tests/ProviderFormModal.test.tsx` | 预设下拉行为组件测试 | 改（追加用例） |
| `packages/frontend/e2e/settings-provider.spec.ts` | 预设快捷选择 E2E（自我清理） | 改（追加用例） |
| `CHANGELOG.md` | 按 AGENTS.md §7 顶部记一条 | 改 |

---

## Task 1: 预设数据模块（shared）

**Files:**
- Create: `packages/shared/src/provider-presets.ts`
- Modify: `packages/shared/src/index.ts`（末尾加一行导出）
- Test: `packages/shared/tests/provider-presets.test.ts`

- [ ] **Step 1: 写失败的单元测试**

Create `packages/shared/tests/provider-presets.test.ts`:

```ts
import { test, expect } from "bun:test";
import { PROVIDER_PRESETS } from "../src/provider-presets";
import type { ProviderApi } from "../src/providers";

const VALID_APIS: ProviderApi[] = ["openai-completions", "anthropic-messages"];

test("PROVIDER_PRESETS 恰好 10 条且 key 唯一", () => {
  expect(PROVIDER_PRESETS.length).toBe(10);
  const keys = PROVIDER_PRESETS.map(p => p.key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("每条预设字段合法（name / baseUrl / api / models / 数值）", () => {
  for (const p of PROVIDER_PRESETS) {
    expect(p.name.length).toBeGreaterThan(0);
    expect(p.baseUrl.startsWith("https://")).toBe(true);
    expect(VALID_APIS).toContain(p.api);
    expect(p.models.length).toBeGreaterThanOrEqual(1);
    for (const m of p.models) {
      expect(m.id.length).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxTokens).toBeGreaterThan(0);
    }
  }
});

test("计划类（plan:true）预设必带 hint", () => {
  const planPresets = PROVIDER_PRESETS.filter(p => p.plan);
  expect(planPresets.length).toBeGreaterThanOrEqual(1);
  for (const p of planPresets) {
    expect((p.hint ?? "").length).toBeGreaterThan(0);
  }
});

test("每条预设可无丢失映射成 ModelProvider", () => {
  for (const p of PROVIDER_PRESETS) {
    const provider = {
      id: "test-id",
      apiKey: "test-key",
      name: p.name,
      baseUrl: p.baseUrl,
      api: p.api,
      models: p.models,
    };
    expect(provider.models.length).toBe(p.models.length);
    // 模型数值原样保留
    const first = provider.models[0];
    expect(first.contextWindow).toBeGreaterThan(0);
    expect(first.maxTokens).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test packages/shared/tests/provider-presets.test.ts`
Expected: FAIL — `Cannot find module "../src/provider-presets"`

- [ ] **Step 3: 写最小实现**

Create `packages/shared/src/provider-presets.ts`:

```ts
import type { ProviderApi, ProviderModel } from "./providers";

/** 供应商预设（填表模板，不含 id / apiKey） */
export interface ProviderPreset {
  /** 唯一标识，如 "glm" / "glm-coding-plan" / "deepseek" */
  key: string;
  /** 默认显示名，如 "智谱 GLM（编程计划）" */
  name: string;
  baseUrl: string;
  /** "openai-completions" | "anthropic-messages" */
  api: ProviderApi;
  models: ProviderModel[];
  /** 是否「计划」接入（独立端点）→ 下拉加 🏷 前缀 */
  plan?: boolean;
  /** 可选提示文案（计划类 / 聚合代理用于说明 Key 要求 / 合规限制） */
  hint?: string;
}

/**
 * 10 条主流供应商预设。模型数值（contextWindow / maxTokens / supportsVision）
 * 为 2026-07 各官方文档的最佳近似，用户在表单里均可改。详见
 * docs/superpowers/specs/2026-07-10-provider-presets-design.md。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "glm",
    name: "智谱 GLM（标准）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
    api: "openai-completions",
    models: [
      { id: "glm-5.2", contextWindow: 1048576, maxTokens: 131072 },
      { id: "glm-4.7", contextWindow: 131072, maxTokens: 16384 },
    ],
  },
  {
    key: "glm-coding-plan",
    name: "智谱 GLM（编程计划）",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    api: "openai-completions",
    plan: true,
    hint: "智谱编程套餐专用端点，需购买 Coding Plan 并使用套餐 Key；套餐 Key 与标准端点不通用，用错端点会报余额不足。",
    models: [
      { id: "glm-5.2", contextWindow: 1048576, maxTokens: 131072 },
      { id: "glm-4.7", contextWindow: 131072, maxTokens: 16384 },
    ],
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    models: [
      { id: "deepseek-chat", contextWindow: 64000, maxTokens: 8192 },
      { id: "deepseek-reasoner", contextWindow: 64000, maxTokens: 32768 },
    ],
  },
  {
    key: "kimi",
    name: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    api: "openai-completions",
    models: [
      { id: "kimi-k2.7-code", contextWindow: 262144, maxTokens: 32768, supportsVision: true },
      { id: "kimi-k2.7-code-highspeed", contextWindow: 262144, maxTokens: 32768, supportsVision: true },
    ],
  },
  {
    key: "claude",
    name: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [
      { id: "claude-opus-4-8", contextWindow: 1000000, maxTokens: 128000, supportsVision: true },
      { id: "claude-sonnet-5", contextWindow: 1000000, maxTokens: 128000, supportsVision: true },
      { id: "claude-fable-5", contextWindow: 1000000, maxTokens: 128000, supportsVision: true },
      { id: "claude-haiku-4-5", contextWindow: 200000, maxTokens: 128000, supportsVision: true },
    ],
  },
  {
    key: "gpt",
    name: "OpenAI GPT",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    models: [
      { id: "gpt-5.5", contextWindow: 1000000, maxTokens: 128000, supportsVision: true },
      { id: "gpt-5", contextWindow: 400000, maxTokens: 128000, supportsVision: true },
    ],
  },
  {
    key: "qwen",
    name: "阿里通义 Qwen（标准）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    models: [
      { id: "qwen3-max", contextWindow: 131072, maxTokens: 16384 },
      { id: "qwen3-coder-plus", contextWindow: 262144, maxTokens: 65536 },
      { id: "qwen3-plus", contextWindow: 1048576, maxTokens: 16384 },
    ],
  },
  {
    key: "doubao",
    name: "火山豆包 Doubao",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    api: "openai-completions",
    hint: "豆包模型 ID 带版本日期、易变；也可在方舟控制台创建推理接入点，用 ep-xxx 接入点 ID 替代。",
    models: [
      { id: "doubao-seed-2.1", contextWindow: 262144, maxTokens: 32768 },
      { id: "doubao-seed-2-0-lite-260428", contextWindow: 262144, maxTokens: 16384 },
    ],
  },
  {
    key: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    hint: "OpenRouter 为聚合代理，模型 slug 形如 提供商/模型名；具体上下文 / 输出上限以 openrouter.ai/models 为准。",
    models: [
      { id: "z-ai/glm-5.2", contextWindow: 1048576, maxTokens: 131072 },
      { id: "anthropic/claude-sonnet-5", contextWindow: 1000000, maxTokens: 128000, supportsVision: true },
      { id: "openai/gpt-5.5", contextWindow: 1000000, maxTokens: 128000, supportsVision: true },
      { id: "moonshotai/kimi-k2.7-code", contextWindow: 262144, maxTokens: 32768, supportsVision: true },
    ],
  },
  {
    key: "bailian-coding-plan",
    name: "阿里云百炼编程计划",
    baseUrl: "https://coding.dashscope.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    plan: true,
    hint: "阿里云百炼编程计划专属端点，需 sk-sp- 开头专属 Key；官方限制仅限交互式编程工具使用，禁止用于自动化脚本 / 自定义应用后端 —— WaPi 作为应用后端调用存在合规风险，使用前请确认。OpenAI 兼容端点确切路径公开资料有限，需核对。",
    models: [
      { id: "qwen3-coder-plus", contextWindow: 262144, maxTokens: 65536 },
      { id: "qwen3-max", contextWindow: 131072, maxTokens: 16384 },
    ],
  },
];
```

- [ ] **Step 4: 导出预设模块**

Modify `packages/shared/src/index.ts` — 在文件末尾追加一行（现有文件共 5 行 export）：

```ts
export * from "./provider-presets";
```

完整文件应为：

```ts
export * from "./types";
export * from "./constants";
export * from "./pure";
export * from "./providers";
export * from "./skills";
export * from "./provider-presets";
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `bun test packages/shared/tests/provider-presets.test.ts`
Expected: PASS（4 个用例全绿）

- [ ] **Step 6: shared 类型检查**

Run: `bun run --filter @wa-pi/shared typecheck`
Expected: 无错误。

- [ ] **Step 7: 提交**

```bash
git add packages/shared/src/provider-presets.ts packages/shared/src/index.ts packages/shared/tests/provider-presets.test.ts
git commit -m "feat(shared): 添加模型供应商预设数据（10 条主流供应商）"
```

---

## Task 2: 表单「快捷选择」下拉（frontend 组件）

**Files:**
- Modify: `packages/frontend/src/components/settings/ProviderFormModal.tsx`
- Test: `packages/frontend/tests/ProviderFormModal.test.tsx`（追加用例）

- [ ] **Step 1: 写失败的组件测试**

Append 5 个用例到 `packages/frontend/tests/ProviderFormModal.test.tsx`（文件末尾，现有 import 已含 `test, expect, mock, beforeEach`、`render, screen, fireEvent`、`useProvidersStore`，无需新增 import）：

```ts
test("快捷选择下拉包含自定义与全部预设", () => {
  render(<ProviderFormModal onClose={() => {}} />);
  const select = screen.getByTestId("preset-select") as HTMLSelectElement;
  const options = Array.from(select.options).map(o => o.textContent ?? "");
  expect(options[0]).toContain("自定义");
  expect(select.options.length).toBe(1 + 10);
  expect(options.some(t => t.includes("智谱 GLM（编程计划）"))).toBe(true);
  expect(options.some(t => t.includes("阿里云百炼编程计划"))).toBe(true);
});

test("选择 DeepSeek 预设自动填入字段且 apiKey 为空", () => {
  render(<ProviderFormModal onClose={() => {}} />);
  fireEvent.change(screen.getByTestId("preset-select"), { target: { value: "deepseek" } });
  expect((screen.getByTestId("field-name") as HTMLInputElement).value).toBe("DeepSeek");
  expect((screen.getByTestId("field-baseUrl") as HTMLInputElement).value).toBe("https://api.deepseek.com");
  expect((screen.getByLabelText("OpenAI 兼容") as HTMLInputElement).checked).toBe(true);
  const matches = screen.getAllByText("deepseek-chat");
  expect(matches.length).toBeGreaterThanOrEqual(1);
  expect((screen.getByTestId("field-apiKey") as HTMLInputElement).value).toBe("");
});

test("选择计划预设显示 hint 提示", () => {
  render(<ProviderFormModal onClose={() => {}} />);
  fireEvent.change(screen.getByTestId("preset-select"), { target: { value: "glm-coding-plan" } });
  expect(screen.getByText(/套餐 Key 与标准端点不通用/)).toBeTruthy();
});

test("编辑模式下显示覆盖提示", () => {
  render(
    <ProviderFormModal
      initial={{
        id: "p1", name: "Existing", baseUrl: "https://api.existing.com/v1",
        apiKey: "sk-existing", api: "openai-completions",
        models: [{ id: "existing-model", contextWindow: 32000, maxTokens: 4096 }],
      }}
      onClose={() => {}}
    />
  );
  expect(screen.getByText("选择预设会覆盖当前表单")).toBeTruthy();
});

test("选择预设后保存的模型含预设真实上下文与输出上限（非默认值）", () => {
  const saveMock = mock();
  useProvidersStore.setState({ save: saveMock });
  render(<ProviderFormModal onClose={() => {}} />);
  fireEvent.change(screen.getByTestId("preset-select"), { target: { value: "deepseek" } });
  fireEvent.change(screen.getByTestId("field-apiKey"), { target: { value: "sk-x" } });
  fireEvent.click(screen.getByTestId("provider-save-btn"));
  const saved = saveMock.mock.calls[0][0];
  expect(saved.models.length).toBe(2);
  const chat = saved.models.find((m: { id: string }) => m.id === "deepseek-chat");
  expect(chat.contextWindow).toBe(64000);
  expect(chat.maxTokens).toBe(8192);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test packages/frontend/tests/ProviderFormModal.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="preset-select"]`

- [ ] **Step 3: 实现下拉与填表逻辑**

Modify `packages/frontend/src/components/settings/ProviderFormModal.tsx`，共 4 处改动：

**(a) 导入预设常量** — 替换第 5 行：

```ts
import type { ModelProvider, ProviderApi, ProviderModel } from "@wa-pi/shared";
```

为：

```ts
import { PROVIDER_PRESETS } from "@wa-pi/shared";
import type { ModelProvider, ProviderApi, ProviderModel } from "@wa-pi/shared";
```

**(b) 新增 state + 派生选中预设** — 在 `const [testStatus, setTestStatus] = ...`（约第 28 行）之后插入：

```ts
  const [selectedPresetKey, setSelectedPresetKey] = useState<string>("");
  const selectedPreset = PROVIDER_PRESETS.find(p => p.key === selectedPresetKey);
```

**(c) 新增 applyPreset 函数** — 在 `handleTagsChange`（约第 31–40 行）之后、`const valid = ...`（约第 42 行）之前插入：

```ts
  // 选预设 → 填表（不走 handleTagsChange，避免把预设数值套成默认 128000/4096）
  const applyPreset = (key: string): void => {
    setSelectedPresetKey(key);
    if (!key) return; // 选「自定义」不清空
    const preset = PROVIDER_PRESETS.find(p => p.key === key);
    if (!preset) return;
    setName(preset.name);
    setBaseUrl(preset.baseUrl);
    setApi(preset.api);
    setModelIds(preset.models.map(m => m.id));
    setModelConfigs(Object.fromEntries(preset.models.map(m => [m.id, m])));
    // apiKey 不动（新增时为空）
  };
```

**(d) 表单顶部插入下拉 JSX** — 在 `<div className="p-4 flex flex-col gap-3 overflow-auto" ...>`（约第 69 行）之后、第一个 `<label>供应商名称</label>`（约第 70 行）之前插入：

```tsx
        <div className="flex flex-col gap-1">
          <span className="text-xs text-secondary">快捷选择</span>
          <select
            data-testid="preset-select"
            value={selectedPresetKey}
            onChange={e => applyPreset(e.target.value)}
            className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
          >
            <option value="">自定义（手动填写）</option>
            {PROVIDER_PRESETS.map(p => (
              <option key={p.key} value={p.key}>
                {p.plan ? "🏷 " : ""}{p.name}
              </option>
            ))}
          </select>
          {initial && (
            <span className="text-xs" style={{ color: "var(--danger)" }}>选择预设会覆盖当前表单</span>
          )}
          {selectedPreset?.hint && (
            <span className="text-xs text-tertiary">{selectedPreset.hint}</span>
          )}
        </div>
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test packages/frontend/tests/ProviderFormModal.test.tsx`
Expected: PASS（原有 7 个 + 新增 5 个，共 12 个用例全绿）

- [ ] **Step 5: frontend 类型检查**

Run: `bun run --filter @wa-pi/frontend typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add packages/frontend/src/components/settings/ProviderFormModal.tsx packages/frontend/tests/ProviderFormModal.test.tsx
git commit -m "feat(frontend): 供应商表单新增快捷选择预设下拉"
```

---

## Task 3: E2E 端到端用例（Playwright）

**Files:**
- Modify: `packages/frontend/e2e/settings-provider.spec.ts`（在 `test.describe.serial` 内末尾追加一个用例）

- [ ] **Step 1: 追加 E2E 用例（自我清理，不污染 serial 计数）**

在 `packages/frontend/e2e/settings-provider.spec.ts` 的 `test.describe.serial("设置页供应商管理", () => { ... })` 内、最后一个 `test("删除供应商流程", ...)` 之后追加：

```ts
  test("快捷选择预设填充表单并保存", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "project:create", name: "e2e-settings", cwd: "/tmp/e2e-settings" }));
      await new Promise(r => setTimeout(r, 200));
      ws.close();
    });

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByTestId("add-provider-btn").click();

    // 选 DeepSeek 预设 → 字段被自动填入
    await page.getByTestId("preset-select").selectOption("deepseek");
    await expect(page.getByTestId("field-name")).toHaveValue("DeepSeek");
    await expect(page.getByTestId("field-baseUrl")).toHaveValue("https://api.deepseek.com");
    await expect(page.locator('[data-testid="tag-input"]').getByText("deepseek-chat")).toBeVisible();

    // 补 apiKey 后保存
    await page.getByTestId("field-apiKey").fill("sk-e2e-preset");
    await page.getByTestId("provider-save-btn").click();
    await expect(page.getByTestId("provider-form-modal")).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid^="provider-card-"]')).toHaveCount(1, { timeout: 5000 });
    await expect(page.getByText("deepseek-chat")).toBeVisible();

    // 自我清理：删除本次新增的供应商，避免污染 serial 计数
    const deleteBtn = page.locator('[data-testid^="provider-delete-"]').first();
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });
    await deleteBtn.click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-ok").click();
    await expect(page.locator('[data-testid^="provider-card-"]')).toHaveCount(0, { timeout: 5000 });
  });
```

- [ ] **Step 2: 运行该 E2E 用例**

需先起 dev 环境（kernel + frontend dev server）。Run（在 repo 根，用 --grep 限定）：

```bash
bun run --filter @wa-pi/frontend e2e -- --grep "快捷选择预设填充表单并保存"
```

Expected: PASS（1 passed）。若 dev 环境未起，参考 `scripts/dev.ts` 启动 kernel(9776) + frontend，再跑。

> 提示：完整 E2E 套件（含「打开设置页 / 添加 / 删除 / 快捷选择」4 个用例）回归可跑 `bun run --filter @wa-pi/frontend e2e`，应 4 passed。

- [ ] **Step 3: 提交**

```bash
git add packages/frontend/e2e/settings-provider.spec.ts
git commit -m "test(e2e): 补充供应商预设快捷选择端到端用例"
```

---

## Task 4: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`（顶部最新位置追加一条，格式对齐既有条目）

- [ ] **Step 1: 记录变更**

Read `CHANGELOG.md`，对齐其既有格式，在**顶部最新日期**位置追加一条。条目内容（文案固定，日期为 2026-07-10）：

```
- feat: 模型供应商新增「快捷选择」预设下拉。添加 / 编辑供应商表单顶部内置 10 条主流供应商预设（智谱 GLM 标准 / GLM 编程计划 / DeepSeek / 月之暗面 Kimi / Anthropic Claude / OpenAI GPT / 阿里通义 Qwen / 火山豆包 / OpenRouter / 阿里云百炼编程计划）。选中后自动填入名称、Base URL、协议类型与模型列表（含上下文窗口 / 最大输出 / 是否视觉），apiKey 仍需手动填；所有字段填入后仍可编辑。计划类（独立端点）预设带 🏷 前缀并显示 Key 要求 / 合规提示。
```

- [ ] **Step 2: 提交**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录供应商预设快捷选择功能"
```

---

## Task 5: 全量回归

- [ ] **Step 1: 全量单元 + 组件测试**

Run: `bun test`
Expected: 全绿（含原有 shared / kernel / frontend 用例 + 新增 provider-presets / ProviderFormModal 用例）。E2E 不在此命令内。

- [ ] **Step 2: 全量类型检查**

Run: `bun run --filter '*' --if-present typecheck`
Expected: 各包无类型错误。

- [ ] **Step 3: 确认未越界改动**

Run: `git diff --stat master..HEAD`（或 `git diff --stat` 若未开分支）
Expected: 仅以下文件变动：
- `packages/shared/src/provider-presets.ts`（新）
- `packages/shared/src/index.ts`
- `packages/shared/tests/provider-presets.test.ts`（新）
- `packages/frontend/src/components/settings/ProviderFormModal.tsx`
- `packages/frontend/tests/ProviderFormModal.test.tsx`
- `packages/frontend/e2e/settings-provider.spec.ts`
- `CHANGELOG.md`

若出现 `provider-store.ts` / `provider-extension.ts` / `provider-test.ts` / `providers.ts` / `types.ts` / `ws-server.ts` 等后端文件改动 → 越界，需回退（本需求后端零改动）。

---

## Self-Review（计划完成后自查）

**Spec 覆盖：**
- §1 目标 1（顶部 select）→ Task 2(d)。✓
- §1 目标 2（选中填 name/baseUrl/api/models，apiKey 空）→ Task 2(c) applyPreset + Task 2 Step 1 用例 2/5。✓
- §1 目标 3（字段仍可编辑）→ 现有表格 input（contextWindow/maxTokens/vision）不动，预设填后可改；Task 2 Step 1 用例 5 验证保存值。✓
- §1 目标 4（计划独立条目）→ Task 1 数据（glm-coding-plan / bailian-coding-plan，plan:true）。✓
- §1 目标 5（保留自定义默认项）→ Task 2(d) `<option value="">自定义（手动填写）`。✓
- §2 数据模型 → Task 1 provider-presets.ts + index.ts 导出。✓
- §3 十条预设 → Task 1 PROVIDER_PRESETS。✓
- §4.1 下拉 + 🏷 前缀 + hint → Task 2(d)。✓
- §4.2 填表逻辑（不走 handleTagsChange）→ Task 2(c)。✓
- §4.3 编辑模式提示 → Task 2(d) `initial && ...` + Task 2 Step 1 用例 4。✓
- §6 错误处理（数据完整性单测）→ Task 1 Step 1。✓
- §7 四层测试 → Task 1（单元）/ Task 2（组件）/ Task 3（E2E）/ Task 5（既有 ws-provider 回归由 `bun test` 覆盖）。✓
- §7 API 接口层：协议未变，既有 ws-provider 用例由 Task 5 `bun test` 全量回归。✓
- AGENTS.md §7 CHANGELOG → Task 4。✓

**Placeholder 扫描：** 无 TBD/TODO；所有代码块为完整可粘贴内容；命令含预期输出。

**类型一致性：** `ProviderPreset`（key/name/baseUrl/api/models/plan?/hint?）在 Task 1 定义，Task 2 引用 `PROVIDER_PRESETS`、`p.key`、`p.plan`、`p.hint`、`p.models` 全部一致；`applyPreset` 直接写 `setModelConfigs(Object.fromEntries(...))` 与现有第 26 行同一模式，类型 `Record<string, ProviderModel>` 可接受。`selectedPreset?.hint` 可空链式与 `hint?: string` 一致。

---

## 完成判据

1. `bun test` 全绿；frontend typecheck 无错。
2. 表单顶部出现「快捷选择」下拉，含「自定义」+ 10 条预设；选 DeepSeek 自动填表且 apiKey 为空；选计划预设出现 hint；编辑模式出现覆盖提示。
3. 选预设保存出的模型含预设真实数值（如 deepseek-chat 64000/8192），非默认 128000/4096。
4. 后端文件零改动（git diff 校验）。
5. CHANGELOG 已记一条。
