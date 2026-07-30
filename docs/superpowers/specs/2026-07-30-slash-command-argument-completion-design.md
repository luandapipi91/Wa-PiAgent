# 斜杠命令二级补全（/goal 子命令提示）设计

**日期：** 2026-07-30
**状态：** 设计待评审

## 背景与问题

安装动态插件（如 `@narumitw/pi-goal`）后，pi 运行时会注入斜杠命令（如 `/goal`）。HiAgent 能在输入框敲 `/` 时补全到**一级命令名**，但 `/goal` 这类命令支持**二级命令/参数**（`pause / resume / clear / edit / status / add / prioritize / drop-last / skip`），HiAgent 无法提供二级补全提示。

## 根因（事实核查结论）

"无法补全二级命令"不是 HiAgent 单方面的 bug，而是**底层 pi 的 RPC 协议没有把子命令数据暴露出来**：

| 层级 | 事实 | 证据 |
|------|------|------|
| 插件层（有数据） | pi-goal 注册了 `getArgumentCompletions` 回调，能动态返回子命令 | `pi-goal/src/goal.ts:403` + `command.ts:54-66` |
| pi 运行时（有数据但 RPC 不传） | `SlashCommandInfo` 类型只有 `name/description/source`，无子命令字段；`get_commands` RPC 只返回扁平 4 字段 | `pi-coding-agent/dist/core/slash-commands.d.ts:3-8` + `rpc-mode.js:520-546` |
| pi RPC 协议（无补全通道） | RPC 命令类型里没有 `complete_command` 之类的"按前缀补全"接口 | `rpc-types.d.ts`（16-129 行，无补全类 type） |
| HiAgent（拿不到数据） | 作为 RPC 客户端，技术上无法获取插件的 `getArgumentCompletions` 返回值 | `kernel/src/rpc-client.ts:163-166` |

**关键约束：pi-goal 的子命令是上下文敏感的**（`experimentalGoals` 开关会增减 `add/prioritize/drop-last/skip`），静态表方案无法准确反映，必须动态获取。

## 方案：扩展 pi RPC 协议（complete_command）

在 pi 的 RPC 模式新增 `complete_command` 命令，调用插件的 `getArgumentCompletions` 回调实时返回子命令。补丁通过 kernel 启动时程序化应用到 runtime 的 pi 包（幂等）。所有插件自动受益，数据永远准确。

**可行性已验证：**
- `RegisteredCommand.getArgumentCompletions` 签名 `(argumentPrefix) => AutocompleteItem[] | null`（`extensions/types.d.ts:825`），支持异步（`Awaitable`）。
- `extensionRunner.getCommand(name)` 返回完整 `ResolvedCommand`（含补全回调），`runner.js:409` 已存在，无需改 pi 扩展运行时。
- `AutocompleteItem = {value, label, description?}`（`pi-tui/dist/autocomplete.d.ts:1-5`），这是跨 RPC 传输的契约。

## 补丁落地路径：kernel 启动时程序化打补丁

**已核实的约束：** HiAgent 仓库的 `patchedDependencies`（根 `package.json:27-30`）只对仓库内 workspace 生效；pi 实际装在仓库外的 `~/.wa-pi/runtime`（独立 sidecar，`package.json` 无 patch 配置）。现存 `@0.82.1.patch` **未生效**（runtime 装 0.80.10，两个目标文件都不含补丁内容）。

**方案：** 在 kernel 启动 pi 子进程前，用代码检测 pi 文件是否已打补丁，未打则原地写入（幂等）。补丁定义留在 HiAgent 仓库走 PR 评审，不依赖 runtime 配置，pi 升级后自动重打。

**权衡：** kernel 多一段"改第三方包文件"的逻辑；若 pi 升级后 `rpc-mode.js` 结构变了，字符串替换会失败——但失败可检测（marker 校验），降级为"不提供子命令补全"，不影响主流程。

---

## 设计

### 第 1 节：pi 上游 RPC 扩展

新增 `complete_command` RPC 命令类型（`pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`）：

```ts
type CompleteCommandRequest = {
    id: number;
    type: "complete_command";
    commandName: string;   // 命令名，不含 /，如 "goal"
    prefix: string;        // 命令后的参数前缀，如 "ad" 或 ""
};
```

新增 RPC handler（`rpc-mode.js`，紧跟 `get_commands` case 之后）：

```js
case "complete_command": {
    const { commandName, prefix } = command;
    const cmd = session.extensionRunner.getCommand(commandName);
    if (!cmd || typeof cmd.getArgumentCompletions !== "function") {
        return success(id, "complete_command", { completions: null });
    }
    const completions = await cmd.getArgumentCompletions(prefix);
    return success(id, "complete_command", { completions: completions ?? null });
}
```

**`completions: null` 语义：** "该命令不支持补全"（前端停止轮询）；`[]` = "支持但无匹配"（继续轮询）。二者语义不同，决定前端是否继续请求。

### 第 2 节：HiAgent kernel/shared 类型与 RPC 客户端

#### 2.1 shared 契约类型（`packages/shared/src/commands.ts`）

```ts
// 新增：命令参数补全项（对应 pi 的 AutocompleteItem）
export interface ArgumentCompletion {
  value: string;
  label: string;
  description?: string;
}

// 新增：WS 协议 —— 请求命令参数补全
export interface CommandArgumentCompletionRequest {
  type: "command:complete_args";
  sessionId: string;
  commandName: string;
  prefix: string;
}

// 新增：WS 协议 —— 补全结果
export interface CommandArgumentCompletionResult {
  type: "command:complete_args";
  completions: ArgumentCompletion[] | null;
}
```

#### 2.2 kernel RPC 客户端（`packages/kernel/src/rpc-client.ts`）

```ts
completeCommandArgs(
  commandName: string,
  prefix: string,
): Promise<{ completions: any[] | null }> {
  return this.command({ type: "complete_command", commandName, prefix });
}
```

#### 2.3 kernel WS handler 与 REST 路由

**WS**（`ws-server.ts`，`session:commands` case 旁新增 `command:complete_args` case）：会话不存在或 RPC 失败 → 返回 `null`（不支持），不报错。

**REST**（`routes/projects-sessions.ts`，与 `get_commands` 对称）：
```
POST /api/sessions/:sessionId/commands/:commandName/complete
body: { prefix: string }
→ { completions: ArgumentCompletion[] | null }
```

WS + REST 双通道，前端可自选。

#### 2.4 kernel 补丁应用器（新增 `packages/kernel/src/pi-patch-applier.ts`）

```ts
export async function ensurePiRpcCompletionPatch(piPkgDir: string): Promise<void> {
  const rpcModeFile = join(piPkgDir, "dist/modes/rpc/rpc-mode.js");
  const rpcSrc = await readFile(rpcModeFile, "utf8");
  // 幂等
  if (rpcSrc.includes('case "complete_command"')) return;
  // 校验锚点
  if (!rpcSrc.includes('case "get_commands"')) {
    throw new PatchAnchorMissing(rpcModeFile);
  }
  const patched = injectCompleteCommandCase(rpcSrc);
  await writeFile(rpcModeFile, patched);
}
```

**调用点：** `agent-manager.ts` 创建 pi 子进程前对 runtime pi 包目录调用一次。失败（锚点缺失/不可写）只记日志，不阻断启动。

### 第 3 节：前端触发器 + 候选组装 + 选中处理

#### 3.1 触发器扩展（`frontend/src/quick-invoke/trigger.ts`）

新增第四种触发态 `command-args`：

```ts
export type TriggerType = "agent" | "file" | "skill" | "command" | "command-args";

// detectTrigger 内新增（放在现有 / 命令检测之后）：
const cmdArgsMatch = cleaned.match(/\/\[([^\]]+)\]\s([^\s]*)$/);
if (cmdArgsMatch) {
  return { type: "command-args", query: cmdArgsMatch[2], commandName: cmdArgsMatch[1] };
}
```

`TriggerResult` 扩展可选 `commandName?: string`。

**待实现时验证的点：** chip 清洗规则（第 26-29 行）目前只清洗 `@/#/$/¥` chip，**不清洗 `/[]` 命令 chip**。必须补 `.replace(/\/\[[^\]]+\]/g, " ")`，否则命令 chip 会干扰 `command` 态检测。

#### 3.2 候选组装（`ComposerInput.tsx`）

`command-args` 态候选来源是异步请求：

```tsx
const [argCompletions, setArgCompletions] = useState<ArgumentCompletion[] | null>(null);
const [argsSupported, setArgsSupported] = useState(true);

useEffect(() => {
  if (triggerType !== "command-args" || !trigger?.commandName) {
    setArgCompletions(null);
    return;
  }
  let cancelled = false;
  const t = setTimeout(async () => {
    try {
      const result = await fetchCommandArgCompletions(sessionId, trigger.commandName!, trigger.query);
      if (cancelled) return;
      if (result.completions === null) {
        setArgsSupported(false);
        setArgCompletions(null);
      } else {
        setArgsSupported(true);
        setArgCompletions(result.completions);
      }
    } catch {
      if (!cancelled) setArgCompletions([]); // 临时网络错，下次重试
    }
  }, 120); // 防抖
  return () => { cancelled = true; clearTimeout(t); };
}, [triggerType, trigger?.commandName, trigger?.query, sessionId]);
```

`menuItems` 派发补 `command-args` 分支读 `argItems`。

#### 3.3 选中处理（`handleSelect` 新增分支）

子命令选中语义是**追加**，保留 chip：

```tsx
if (triggerType === "command-args") {
  setDismissed(true);
  const argValue = item.id.slice(4); // 去 "arg:" 前缀
  if (trigger) {
    const queryRe = new RegExp(`${trigger.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    setText(text.replace(queryRe, argValue + " "));
  }
  return;
}
```

#### 3.4 面板渲染（`QuickInvokeMenu` 零改动）

复用现有组件，`type` 标签显示"子命令"。

### 第 4 节：错误处理与边界

| 失败点 | 降级策略 | 用户感知 |
|--------|----------|----------|
| pi 补丁未打/打不上 | kernel 返回 `null` → 前端 `argsSupported=false` | 无子命令补全，主流程正常 |
| pi 进程未就绪 | kernel 返回 `null` | 静默降级 |
| 补全请求超时/网络异常 | 前端 catch → `setArgCompletions([])`，保留 `argsSupported=true`（下次重试） | 面板空一下，下次恢复 |

**不缓存补全结果**（上下文敏感，缓存会脏）。唯一缓存 `argsSupported` 判定（会话周期内稳定）。

### 第 5 节：测试策略（四层验收）

**第一层 单元测试（`bun:test`）：**
- `detectTrigger` 的 `command-args` 态（`/trigger.test.ts` 新增）
- chip 清洗补 `/[]`
- `pi-patch-applier` 幂等/锚点缺失（`kernel/tests/pi-patch-applier.test.ts` 新增）
- `fetchCommandArgCompletions` store

**第二层 组件测试（Vitest + Testing Library）：**
- `ComposerInput` 子命令补全交互（mock fetch，断言面板 + 选中后文本）
- `argsSupported=false` 降级
- 选中后连续补全

**第三层 API 接口测试（curl）：**
- `POST /commands/goal/complete {prefix:""}` → 200 + completions 数组
- `POST /commands/goal/complete {prefix:"ad"}` → 200 + `[add]`
- `POST /commands/nonexistent/complete` → 200 + `null`
- 会话不存在 → 200 + `null`

**第四层 E2E（Playwright）：**
- API 装 pi-goal → 输入 `/goa` → 一级面板含 `/goal` → 选中 → 输入框 `/[goal] ` → 按空格 → 子命令面板弹出 → 选 `pause` → 输入框 `/[goal] pause ` → finally 卸载插件 + 删截图

---

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `packages/kernel/src/pi-patch-applier.ts` | **新增**：启动时幂等给 runtime pi 包注入 `complete_command` RPC case |
| `packages/kernel/src/agent-manager.ts` | 调用 `ensurePiRpcCompletionPatch` |
| `packages/kernel/src/rpc-client.ts` | 新增 `completeCommandArgs` |
| `packages/kernel/src/ws-server.ts` | 新增 `command:complete_args` case |
| `packages/kernel/src/routes/projects-sessions.ts` | 新增 REST 路由 |
| `packages/shared/src/commands.ts` | 新增 `ArgumentCompletion` + WS 协议类型 |
| `packages/frontend/src/quick-invoke/trigger.ts` | 新增 `command-args` 态 + chip 清洗 |
| `packages/frontend/src/store/commands.ts` | 新增 `fetchCommandArgCompletions` |
| `packages/frontend/src/components/ui/ComposerInput.tsx` | `argItems` + 异步 effect + `handleSelect` 分支 |

## 风险

1. **pi 升级导致补丁锚点失效**：`get_commands` case 结构变了 → 补丁打不上 → 降级无子命令补全（不阻断）。需在补丁应用器日志里明确告警，便于排查。
2. **补丁改第三方包文件的 hack 味道**：已用"幂等 + 锚点校验 + 失败降级"三重防护缓解；长期理想方案是推动 pi 上游原生支持（但本期不做）。
3. **runtime 在用户机器上**：补丁由 kernel 启动时自动打，用户无感；但若用户手动重装 pi（删 runtime 重装），补丁会丢失——kernel 下次启动会自动重打。
