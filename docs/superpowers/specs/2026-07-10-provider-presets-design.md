# 模型供应商预设（快捷选择）

- **日期**: 2026-07-10
- **状态**: 设计已确认，待实现
- **范围**: 在现有自定义供应商表单顶部新增「快捷选择」下拉，内置 10 条主流供应商预设；预置含「计划（独立端点）」条目；选中后自动填入名称 / Base URL / 协议 / 模型列表（apiKey 仍需用户填）
- **关联**: 增量于 [2026-07-09-settings-provider-management-design.md](./2026-07-09-settings-provider-management-design.md)，**推翻**其「不做预设供应商模板（纯自定义）」的 YAGNI 决定

---

## 1. 目标与范围

### 目标
现有「添加 / 编辑供应商」表单（`ProviderFormModal`）为纯手动填写。本次：

1. 表单顶部新增原生 `<select>`「快捷选择」，内置 10 条主流供应商预设。
2. 选中预设 → 自动填入 name / baseUrl / api / models（含每个模型的 contextWindow / maxTokens / supportsVision），apiKey 保持空（用户必填）。
3. 字段填入后仍可任意编辑（预设只是「填表模板」，不锁死）。
4. 对存在「计划（独立接入端点）」的供应商（GLM 编程计划、阿里云百炼编程计划），单独列出一条带（计划）标识的预设。
5. 保留「自定义（手动填写）」作为下拉默认项 —— 现有自定义模式不受影响。

### 不做（YAGNI）
- **不改任何后端**：`ModelProvider` / `ProviderModel` 类型、WS 协议、`provider-store.ts` / `provider-extension.ts` / `provider-test.ts`、`provider-extension.ts:27` 的 `reasoning:false` 全不动。本需求里「计划」= 独立 preset 条目，不是模型的推理能力字段。
- 不做预设的远程拉取 / 版本更新：预设是写死的常量数组。
- 不做「计划」的结构化 schema（不往 `ModelProvider` 加 plan 字段）：计划信息只存在于预设层（`ProviderPreset.plan` / `hint`），落库后与普通供应商无异。
- 不做预设分类筛选 / 搜索 UI（10 条用裸 `<select>` 足够）。

---

## 2. 数据模型

新增文件 `packages/shared/src/provider-presets.ts`，并在 `packages/shared/src/index.ts` 加 `export * from "./provider-presets"`。

```ts
import type { ProviderApi, ProviderModel } from "./providers";

/** 供应商预设（填表模板，不含 id / apiKey） */
export interface ProviderPreset {
  key: string;          // 唯一标识，如 "glm" / "glm-coding-plan" / "deepseek"
  name: string;         // 默认显示名，如 "智谱 GLM"
  baseUrl: string;
  api: ProviderApi;     // "openai-completions" | "anthropic-messages"
  models: ProviderModel[];
  plan?: boolean;       // 是否「计划」接入（独立端点）→ 下拉显示 (计划) 徽标
  hint?: string;        // 可选提示文案（计划类预设用于说明 Key 要求 / 合规限制）
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // … 见第 3 节 10 条
];
```

> 说明：`ProviderPreset` 与 `ModelProvider` 形状一致（仅少 `id` / `apiKey`，多 `key` / `plan` / `hint`）。选中预设时由前端把预设字段映射进表单 state；保存时仍走现有 `save(ModelProvider)`，生成的对象与手填供应商**完全同构**，落库 / Pi 注册 / slugify / 连通测试链路零改动。

---

## 3. 预设清单（10 条，含联网核实的配置）

> 模型数值（contextWindow / maxTokens / supportsVision）为各官方文档的最佳近似，用户在表单里均可改。带 ⚠️ 的条目公开资料有限 / 易变，标注「需核对」。

| # | key | 显示名 | api | baseUrl | 计划? |
|---|---|---|---|---|---|
| 1 | `glm` | 智谱 GLM（标准） | openai | `https://open.bigmodel.cn/api/paas/v4/` | 否 |
| 2 | `glm-coding-plan` | 智谱 GLM（编程计划） | openai | `https://open.bigmodel.cn/api/coding/paas/v4` | 是 |
| 3 | `deepseek` | DeepSeek | openai | `https://api.deepseek.com` | 否 |
| 4 | `kimi` | 月之暗面 Kimi | openai | `https://api.moonshot.cn/v1` | 否 |
| 5 | `claude` | Anthropic Claude | anthropic | `https://api.anthropic.com` | 否 |
| 6 | `gpt` | OpenAI GPT | openai | `https://api.openai.com/v1` | 否 |
| 7 | `qwen` | 阿里通义 Qwen（标准） | openai | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 否 |
| 8 | `doubao` | 火山豆包 Doubao | openai | `https://ark.cn-beijing.volces.com/api/v3` | 否 |
| 9 | `openrouter` | OpenRouter | openai | `https://openrouter.ai/api/v1` | 否 |
| 10 | `bailian-coding-plan` | 阿里云百炼编程计划 | openai | `https://coding.dashscope.aliyuncs.com/compatible-mode/v1` ⚠️ | 是 |

### 各预设模型清单（id / contextWindow / maxTokens / supportsVision）

> ⚠️ **模型版本迭代极快，本表为 2026-07 联网核实的当前版本。** contextWindow / maxTokens 以各官方文档为准、用户在表单里均可改；标 ⚠️ 的 ID 易变或公开资料有限。预设只是「起点」，不强求永远最新 —— 见 §9 关于数据时效的说明。

**1. 智谱 GLM（标准）**
- `glm-5.2` — 1048576 / 131072 / false（当前旗舰，1M 上下文；显式启用用 `glm-5.2[1m]`）
- `glm-4.7` — 131072 / 16384 / false

**2. 智谱 GLM（编程计划）** `plan:true`
- `glm-5.2` — 1048576 / 131072 / false
- `glm-4.7` — 131072 / 16384 / false
- `hint`: 「智谱编程套餐专用端点，需购买 Coding Plan 并使用套餐 Key；套餐 Key 与标准端点不通用，用错端点会报余额不足。」

**3. DeepSeek**（已升级 DeepSeek-V3.2）
- `deepseek-chat` — 64000 / 8192 / false（V3.2 非思考模式）
- `deepseek-reasoner` — 64000 / 32768 / false（V3.2 思考模式）

**4. 月之暗面 Kimi**（kimi-k2 系列已于 2026-05-25 下线，改用 k2.7）
- `kimi-k2.7-code` — 262144 / 32768 / true（当前编码旗舰，256K 上下文，支持视觉）
- `kimi-k2.7-code-highspeed` — 262144 / 32768 / true（同模型高速版 ~180 tok/s）

**5. Anthropic Claude**（anthropic-messages）
- `claude-opus-4-8` — 1000000 / 128000 / true
- `claude-sonnet-5` — 1000000 / 128000 / true
- `claude-fable-5` — 1000000 / 128000 / true
- `claude-haiku-4-5` — 200000 / 128000 / true

**6. OpenAI GPT**
- `gpt-5.5` — 1000000 / 128000 / true（API 1M 上下文）
- `gpt-5` — 400000 / 128000 / true

**7. 阿里通义 Qwen（标准）**（Qwen3.x 系列）⚠️ 确切 ID / 上下文以百炼文档为准
- `qwen3-max` — 131072 / 16384 / false
- `qwen3-coder-plus` — 262144 / 65536 / false
- `qwen3-plus` — 1048576 / 16384 / false（默认 1M 上下文）

**8. 火山豆包 Doubao** ⚠️（模型 ID 带版本日期、易变，需在方舟控制台核对）
- `doubao-seed-2.1` — 262144 / 32768 / false
- `doubao-seed-2-0-lite-260428` — 262144 / 16384 / false
- `hint`: 「豆包模型 ID 带版本日期、易变；也可在方舟控制台创建推理接入点，用 ep-xxx 接入点 ID 替代。」

**9. OpenRouter**（聚合代理，上下文 / 输出上限随上游模型而变）
- `z-ai/glm-5.2` — 1048576 / 131072 / false
- `anthropic/claude-sonnet-5` — 1000000 / 128000 / true
- `openai/gpt-5.5` — 1000000 / 128000 / true
- `moonshotai/kimi-k2.7-code` — 262144 / 32768 / true
- `hint`: 「OpenRouter 为聚合代理，模型 slug 形如 提供商/模型名；具体上下文 / 输出上限以 openrouter.ai/models 为准。」

**10. 阿里云百炼编程计划** `plan:true` ⚠️（OpenAI 兼容端点确切路径待核对）
- `qwen3-coder-plus` — 262144 / 65536 / false
- `qwen3-max` — 131072 / 16384 / false
- `hint`: 「阿里云百炼编程计划专属端点，需 sk-sp- 开头专属 Key；官方限制仅限交互式编程工具使用，禁止用于自动化脚本 / 自定义应用后端 —— WaPi 作为应用后端调用存在合规风险，使用前请确认。OpenAI 兼容端点确切路径公开资料有限，需核对。」

> 数据来源：[智谱 OpenAI 兼容](https://docs.bigmodel.cn/cn/guide/platform/model-migration) · [智谱 Coding Plan FAQ](https://docs.bigmodel.cn/cn/coding-plan/faq) · [DeepSeek 文档](https://api-docs.deepseek.com/) · [Kimi 文档](https://platform.kimi.com/docs/api/chat) · [DashScope OpenAI 兼容](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope) · [火山方舟 OpenAI 兼容](https://www.volcengine.com/docs/82379/1330626) · [OpenRouter 文档](https://openrouter.ai/docs/quickstart) · [百炼 Coding Plan](https://help.aliyun.com/zh/model-studio/coding-plan)

---

## 4. UI 改动（仅 `ProviderFormModal.tsx`）

### 4.1 顶部新增「快捷选择」行

在现有表单最上方（标题栏下方、第一个字段「供应商名称」上方）插入一行：

```
快捷选择
┌────────────────────────────────────────────────┐
│ 自定义（手动填写）                          ▾ │
└────────────────────────────────────────────────┘
```

- 用**原生 `<select>`**（与 `ui/ModelSelector.tsx` 同款，无第三方组件库）。
- `<option>` 列表：`自定义（手动填写）`（默认选中，value 为空）+ `PROVIDER_PRESETS` 每条。
- 每个 `<option>` 的文本统一为 `${preset.name}`（如「智谱 GLM（编程计划）」——name 本身已区分计划与否，无需再叠后缀）。
- `plan:true` 的预设：在该 `<option>` 文本前加前缀 `🏷 ` 做视觉区分；选中**任一带 `hint` 的预设**时，select 下方展示该 `hint` 小字（`text-xs text-tertiary`）—— GLM/百炼编程计划、豆包、OpenRouter 等都带提示，方便用户填表。

### 4.2 选中预设 → 填表

新增本地 state `selectedPresetKey`（默认 `""`）。`<select>` 的 `onChange`：

1. 取 `PROVIDER_PRESETS.find(p => p.key === key)`。
2. 把 `name` / `baseUrl` / `api` 写入对应 state。
3. 直接用预设的模型数据写入（**不走** `handleTagsChange`，否则新行会被套上默认 128000/4096 而丢掉预设里的真实数值）：
   - `setModelIds(preset.models.map(m => m.id))`
   - `setModelConfigs(Object.fromEntries(preset.models.map(m => [m.id, m])))`
   - 这样模型表格行与预设的 contextWindow / maxTokens / supportsVision 一一对应。
4. **apiKey 不动**（保持原值，新增时为空）。
5. 更新 `selectedPresetKey`。

### 4.3 行为细节

- **新增模式**：下拉默认「自定义」；选预设填表后用户补 apiKey 即可保存。
- **编辑模式**（`initial` 非空）：下拉仍渲染，但顶部 select 下方加一行小字提示「选择预设会覆盖当前表单」。选预设会覆盖现有字段值（用户已知风险，靠提示文案兜底）。编辑模式默认 `selectedPresetKey = ""`（不回猜用户原本用了哪个预设 —— YAGNI）。
- 填入后字段完全可编辑：用户可增删模型 tag、改 contextWindow、换协议、改 baseUrl 等。
- 选中「自定义」option 不清空表单（只是回到无预设状态）。

---

## 5. 不改的部分（明确边界）

- `packages/shared/src/providers.ts`（`ModelProvider` / `ProviderModel` / `ProviderApi` / WS 事件 / `slugifyProviderName` / `splitModelIds`）—— 不动。
- `packages/shared/src/types.ts`（WS 联合类型）—— 不动。
- kernel：`provider-store.ts` / `provider-extension.ts`（含 `reasoning:false`）/ `provider-test.ts` / `ws-server.ts` / `index.ts` —— 不动。
- 前端：`ProviderSection.tsx` / `ProviderCard.tsx` / `store/providers.ts` / `ModelSelector.tsx` —— 不动。
- 持久化格式 `providers.json` —— 不动（预设选中后保存出的对象与手填供应商同构）。

---

## 6. 错误处理

- **预置数据完整性**：单测断言 `PROVIDER_PRESETS` 每条 `key` 唯一、`baseUrl` 非空且以 `https://` 开头、`api` ∈ 合法值、`models.length >= 1` 且每个模型 `id` 非空、`contextWindow > 0` / `maxTokens > 0`。防止手抄配置出错。
- **计划类合规风险**：百炼编程计划 / GLM 编程计划的 `hint` 明确提示用户合规与 Key 要求，不替用户做决定。
- **连通测试沿用现有逻辑**：`provider-test.ts` 对 openai 走 `GET {baseUrl}/models`，对 anthropic 走最小 `POST /messages`。预设计划端点是否能被该探测通过，取决于上游；探测失败不阻断保存（现有行为）。

---

## 7. 测试策略（四层）

遵循 AGENTS.md §6，四层缺一不可。

### 第一层：单元测试（bun:test）
- `provider-presets.ts`：
  - `PROVIDER_PRESETS` 数据校验（key 唯一、baseUrl 合法、api 合法、models 非空、数值 > 0）。
  - 每条预设可被无丢失地映射成合法 `ModelProvider`（补 id + apiKey 后）。
  - `plan` 条目的 `hint` 非空。

### 第二层：组件测试（bun:test + @testing-library/react + happy-dom）
- `ProviderFormModal`：
  - 渲染时下拉含「自定义」+ 10 条预设。
  - 选「DeepSeek」→ name/baseUrl/api/models 被正确填充，apiKey 仍为空。
  - 选计划预设 → 显示名带（计划）标识、`hint` 小字出现。
  - 编辑模式（传 `initial`）→ 下拉默认「自定义」，select 下方出现「选择预设会覆盖当前表单」提示。
  - 选预设后改某模型 contextWindow → state 更新且保存出的对象含新值（字段仍可编辑）。

### 第三层：API 接口测试（WS / 现有用例回归）
- 协议未变，既有 `ws-provider.test.ts` 全量回归通过（保存出的预设供应商与手填供应商走同一链路）。
- 连通测试对 openai 预设 baseUrl 的探测行为不变（mock fetch）。

### 第四层：E2E（Playwright）
- 新增流程：打开设置 → 添加供应商 → 下拉选「DeepSeek」→ 填 apiKey → 保存 → 断言卡片出现且模型 tag 为 deepseek-chat / deepseek-reasoner。
- 计划预设流程：选「智谱 GLM（编程计划）」→ 断言 hint 文案出现 → 取消（不实际连真实 API）。
- finally 清理：测试产生的 `providers.json` + extension 用独立 `WA_PI_DIR` 隔离；**截图在测试完成后全部删除**。

---

## 8. 落地顺序（实现参考，非强制）

1. `packages/shared/src/provider-presets.ts`：`ProviderPreset` 类型 + `PROVIDER_PRESETS`（10 条）。
2. `packages/shared/src/index.ts`：导出。
3. 第一层单测：预置数据校验。
4. `ProviderFormModal.tsx`：顶部 `<select>` + 填表逻辑 + hint + 编辑模式提示。
5. 第二层组件测试。
6. 第三层回归 + 第四层 E2E。
7. `CHANGELOG.md` 顶部加一条（按 AGENTS.md §7）。

---

## 9. 开放问题 / 后续

- **百炼编程计划 OpenAI 端点确切路径**：公开资料以 Claude Code 的 Anthropic 端点（`/apps/anthropic`）为主，OpenAI 兼容路径待实现时核对官方文档，必要时改用 Anthropic 协议端点。
- **豆包模型 ID 易变**：实现时建议同步一次方舟控制台最新模型列表；后续可考虑「从 /models 拉取」按钮（原 spec §11 已列为后续项）。
- **预设更新机制 / 数据时效（重要）**：模型 ID 与上下文 / 输出上限迭代极快（如 GLM 已到 5.2/1M、Kimi 到 k2.7、kimi-k2 系列已下线），写死的 `PROVIDER_PRESETS` 必然滞后。本次设计对此的处置：
  1. 预设仅作「起点」——选中后所有字段（含模型 tag、ctx、out、vision、协议、baseUrl）皆可在表单里改，用户随时能修正成最新值；
  2. 表单保留现有「测试连接」与（原 spec §11 已列后续项的）「从 `/models` 拉取」能力，作为对冲滞后的手段；
  3. `PROVIDER_PRESETS` 集中在单文件常量数组里，后续更新模型只需改这一处，无需动后端。
  远程拉取 / 版本化预设列为后续增强，本次不做（YAGNI）。
- **GLM 编程计划协议选择**：本次按用户决定用 OpenAI 编程端点 `/coding/paas/v4`；若实际调用有签名问题，可改用 Anthropic 端点 `/api/anthropic`（届时该预设 `api` 改为 `anthropic-messages`）。
