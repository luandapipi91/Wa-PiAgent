# pi-dynamic-workflows 评估与 WaPi 的 Pi 扩展复用原则

> 日期：2026-07-20
> 来源：https://pi.dev/packages/@quintinshaw/pi-dynamic-workflows + https://github.com/QuintinShaw/pi-dynamic-workflows README
> 状态：调研存档（后期多智能体编排议题的起点）

## 一、背景：当时的调研遗漏

WaPi 在 2026-07-05 ~ 2026-07-17 的 Pi 生态调研中，只在 `2026-07-05-wa-pi-design.md:27` 列出过 pi-dynamic-workflows 的名字（作为"成熟编排后端"之一），但：

- `docs/research/` 下**没有** pi-dynamic-workflows 的专门评估文件
- `2026-07-08-pi-sdk-refactor-design.md:189-200` 的委托扩展对照表里**只有** pi-intercom / @gotgenes/pi-subagents / pi-subagents(nicobailon) / pi-crew——**pi-dynamic-workflows 不在表内**

即：当时**没有深入评估**就排除了它，不是评估后排除。本文档补这份评估。

## 二、pi-dynamic-workflows 实际是什么

它是 **Claude Code dynamic workflows 的 Pi 实现**——一个**重量级工作流编排引擎**，作者 QuintinShaw，27.9K/mo 下载，活跃维护（3.2.2 版本，5 小时前更新）。

### 2.1 核心机制

把一个 prompt 变成**确定性 JavaScript 编排脚本**（LLM 先生成代码，再在 Node vm 沙箱里执行）：

```js
phase('Scan')
const files = await agent('List every route file under src/routes/.', { tier: 'small' })

phase('Review')
const findings = await parallel(
  files.split('\n').filter(Boolean).map((file) =>
    () => agent(`Audit ${file} for missing auth checks.`, {
      tier: 'medium',
      isolation: 'worktree',
    }),
  ),
)

phase('Verify')
return await agent(
  'Synthesize and double-check these findings:\n' + findings.join('\n\n'),
  { tier: 'big' },
)
```

### 2.2 能力清单

| 能力 | 实现 |
|---|---|
| 并行扇出 | `parallel(thunks)`，最多 16 并发 / 1000 总子智能体 |
| 串行 pipeline | `pipeline(items, ...stages)` 阶段串联 |
| 模型路由 | `tier: small/medium/big` 或精确 `provider/model:thinking` |
| git worktree 隔离 | `isolation: "worktree"`，并行编辑不冲突 |
| journaled resume | 中断恢复 + 编辑脚本后只重跑改动部分（按位置索引匹配缓存）|
| token/cost 核算 | 真实 tokens 和成本统计，可选 run/phase/agent 预算 |
| 质量校验 | `verify()` 多评审投票 / `judgePanel()` 评分选最优 / `loopUntilDry()` 收敛 / `completenessCheck()` |
| 交互入口 | `/workflows` TUI 导航 + `/code-review` / `/deep-research` / `/codebase-audit` / `/multi-perspective` 内置命令 |
| keyword trigger | 消息含"workflow"词自动 armed 工具（不强制触发）|
| 后台运行 | 非阻塞 run + 实时进度面板 + 自动结果回送 |

### 2.3 关键架构洞察：脚本层组合绕过 applyRecursionGuard

`@gotgenes/pi-subagents` 内置 `applyRecursionGuard` 硬删除子智能体的 delegate 工具，导致 WaPi 当前深度恒为 1。

pi-dynamic-workflows **绕过了这个问题**——它的「链式」不是靠子智能体递归 delegate，而是**编排器脚本依次/并行调用多个独立子智能体**：

```js
// pipeline 阶段串联：编排器依次调 A、B、C，每个都是独立深度1的子智能体
pipeline(
  items,
  (item) => agent(`A 处理 ${item}`),   // 子智能体 A，深度1
  (result) => agent(`B 加工 ${result}`), // 子智能体 B，深度1
  (final) => agent(`C 校验 ${final}`),  // 子智能体 C，深度1
)
```

效果上等价于 A→B→C 链式，机制上是**编排器组合**而非**子智能体递归**——`applyRecursionGuard` 不触发。这是 WaPi 后期实现链式委托的一条可选路径（无需 fork pi-subagents）。

## 三、为什么 WaPi 不能直接用

### 3.1 关键事实：它是「交互层扩展」，不是「底层服务」

WaPi 能用 `@gotgenes/pi-subagents`，是因为只用了它的**底层 service API**：

```ts
// WaPi delegate-tool.ts:130-135 —— 只用底层 spawn service
const { getSubagentsService } = await import("@gotgenes/pi-subagents");
const svc = getSubagentsService();
id = svc.spawn(agent, task);
```

WaPi 自己包了 `delegate` customTool + DelegateCard UI + partners allowlist——**pi-subagents 的交互层被完全绕过**。

但 pi-dynamic-workflows **没有底层 service API 可借**，它的全部能力都在交互层：
- `/workflows` slash command（Pi CLI 命令，WaPi 的 Composer 不认）
- TUI 进度面板（Pi CLI 的 TUI 渲染，WaPi 的 React UI 看不到）
- keyword trigger（依赖 Pi CLI 的消息提交层，WaPi Composer 不接管）
- `~/.pi/workflows/` 状态目录（WaPi 不读也不展示）
- LLM 生成 JS 脚本 + vm 沙箱执行（需要 Pi 的工具调用机制配合，WaPi 的 delegate 工具是另一套）

### 3.2 用户在 WaPi 里无法"启用"它的编排

它的所有交互入口在 WaPi UI 里一个都不存在：

| pi-dynamic-workflows 入口 | WaPi 里是否工作 |
|---|---|
| `/workflows run <prompt>` slash command | ❌ WaPi Composer 不解析 Pi slash command |
| `/code-review` / `/deep-research` 内置命令 | ❌ 同上 |
| TUI 进度面板 | ❌ WaPi 是 React UI，不是 Pi CLI TUI |
| "workflow" keyword trigger | ❌ 依赖 Pi CLI 消息提交层 |
| `~/.pi/workflows/` 状态 | ❌ WaPi 状态在 `~/.wa-pi/`，不读 `.pi/` |

即使用户在 WaPi 里 `pi install npm:@quintinshaw/pi-dynamic-workflows`，扩展加载了但**所有入口都不工作**——除非 WaPi 做大量适配工作，把它的 TUI/命令/状态都翻译到 WaPi 的 UI/状态模型里。

## 四、WaPi 的 Pi 扩展复用原则（本次确立）

这次评估暴露了一个应该明确的原则：

> **WaPi 只能复用「工具类 / 底层服务类」Pi 扩展，不能复用「交互类」Pi 扩展。**

WaPi 虽然基于 Pi SDK 构建，但它是独立产品（自己的 kernel / frontend / desktop shell / 会话模型 / UI 渲染层）。Pi 扩展能在 WaPi 里工作的前提是：**它的能力通过工具调用或 service API 暴露，而不是通过 Pi CLI 的 slash command / TUI / keyword trigger 暴露**。

### 4.1 分类对照

| 类型 | 特征 | WaPi 能否复用 | 已复用示例 |
|---|---|---|---|
| **工具类** | 注册一个或多个 Pi 工具，通过 `tool` 接口暴露能力 | ✅ 直接复用 | pi-web-access（web 搜索/抓取工具）|
| **底层服务类** | 提供 typed service API，宿主自己包工具 + UI | ✅ 复用 service，自包交互 | @gotgenes/pi-subagents（getSubagentsService）|
| **记忆/存储类** | 提供持久化层 + 读写 API | ✅ 复用 API，自包 UI | pi-hermes-memory（如未来引入）|
| **交互类** | 能力全在 slash command / TUI / 进度面板 / keyword trigger | ❌ 不可直接复用 | pi-dynamic-workflows / pi-crew / gentle-pi |
| **harness 类** | 整套工作流方法论 + 命令体系 + 角色 | ❌ 不可直接复用 | bigpowers / superpowers-zh（skill 形态除外）|

### 4.2 决策规则

引入新 Pi 扩展前，先问 3 个问题：

1. **它的能力是否通过 `tool` 接口或 typed service API 暴露？**
   - 是 → 可复用（工具类 / 底层服务类）
   - 否，只通过 slash command / TUI 暴露 → 不可复用（交互类）
2. **它的状态是否写在 WaPi 能读到的位置（`~/.wa-pi/` 或项目内）？**
   - 是 → 可复用
   - 否，写在 `~/.pi/` 独立目录 → 状态分裂，需要适配
3. **它的 UI 渲染是否依赖 Pi CLI 的 TUI 层？**
   - 否（纯工具/service）→ 可复用
   - 是（TUI/slash command/keyword trigger）→ WaPi UI 层不接管

## 五、WaPi 后期多智能体编排的可行路径

既然 pi-dynamic-workflows 不可直接用，WaPi 要支持编排本质上只有两条路：

| 路径 | 说明 | 成本 | 风险 |
|---|---|---|---|
| **(a) 自研编排层** | WaPi 在 `delegate` 工具之上自研编排（fleet 工具 + 阶段化 UI + 状态管理），借鉴 pi-dynamic-workflows 的 `parallel`/`pipeline`/`verify`/`resume` 设计 | 中高，但完全自主 | 自研负担 |
| **(b) 深度适配 pi-dynamic-workflows** | 把它的 TUI/命令/状态全部翻译到 WaPi UI 层（重写它的交互入口） | 极高，可能比 (a) 还大 | 绑死第三方包，未来方向不可控 |

### 5.1 推荐路径：(a) 自研编排层

**理由**：
1. WaPi 的核心定位是「关系网轻量委托」（partners.askTo），编排是这之上的自然延伸，自主可控
2. 当前 spec 的 B3「fleet 并行委托」已经是 (a) 的第一步——在 delegate 之上加编排能力
3. pi-dynamic-workflows 的设计思路（parallel/pipeline/verify/resume）可以**借鉴但不依赖**——WaPi 在自己的 delegate/fleet 工具 + React UI + ~/.wa-pi 状态模型里实现等价能力

### 5.2 自研编排层的设计借鉴清单

从 pi-dynamic-workflows 借鉴的设计点（仅供 WaPi 后续编排 spec 参考）：

| pi-dynamic-workflows 设计 | WaPi 可借鉴形态 |
|---|---|
| `parallel(thunks)` 并行扇出 | 当前 spec 的 B3 fleet 工具 |
| `pipeline(items, ...stages)` 阶段串联 | 后续「链式委托」议题（在编排层而非子智能体递归解决）|
| `isolation: "worktree"` | 后续「write_paths 硬约束」议题（sandbox 配合）|
| `verify()` / `judgePanel()` | fleet 的可选 cross-check 阶段 |
| journaled resume（按位置索引匹配缓存）| 长任务中断恢复机制 |
| `tier: small/medium/big` 模型路由 | delegate 调用层 model 覆盖（当前 spec C6 已列为后续） |
| `loopUntilDry()` 收敛 | 探索类任务（如 audit）的终止条件 |

## 六、结论

1. **pi-dynamic-workflows 不可直接用于 WaPi**——它是交互类扩展，所有入口在 WaPi UI 里不工作
2. **本次确立 Pi 扩展复用原则**：只复用工具类/底层服务类，不复用交互类（第四节）
3. **后期编排走自研路线**：基于现有 delegate + B3 fleet + partners 关系网，借鉴 pi-dynamic-workflows 设计但不依赖它
4. **补登记这次的调研遗漏**：避免后续再走弯路（第一节）

## 七、相关文档

- `docs/superpowers/specs/2026-07-20-at-mention-delegate-design.md` —— 当前 @ 委托改造 spec，含 B3 fleet（自研编排的第一步）
- `docs/superpowers/specs/2026-07-08-pi-sdk-refactor-design.md` —— 早期 Pi 扩展调研表（当时遗漏了 pi-dynamic-workflows）
- `docs/superpowers/specs/2026-07-05-wa-pi-design.md` —— WaPi 顶层设计
