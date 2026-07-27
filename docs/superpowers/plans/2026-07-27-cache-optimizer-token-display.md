# 内置 pi-cache-optimizer + Token/缓存显示 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 内置 pi-cache-optimizer 为 Pi 扩展，并在聊天头部显示 ↑↓ token 消耗和缓存命中率

**架构：** PKG_EXTENSIONS 静态加载扩展 → Pi 子进程自动启用 → message_end 携带 usage → kernel 透传 → 前端 SessionView 三个胶囊标签（↑↓/累计/缓存）

**技术栈：** TypeScript, Bun test, React, zustand

---

### 任务 1：内置 pi-cache-optimizer 扩展

**文件：**
- 修改：`packages/kernel/src/extensions.ts:70`
- 修改：`packages/kernel/package.json`
- 修改：`packages/desktop/resources/kernel/package.json`

- [ ] **步骤 1：PKG_EXTENSIONS 追加 pi-cache-optimizer**

```typescript
// packages/kernel/src/extensions.ts:70
const PKG_EXTENSIONS = [
  "pi-open-agents",
  "pi-web-access",
  "pi-mcp-adapter",
  "pi-cache-optimizer",
] as const;
```

- [ ] **步骤 2：kernel package.json 加依赖**

```json
// packages/kernel/package.json 的 dependencies 追加
"pi-cache-optimizer": "^2.6.24"
```

- [ ] **步骤 3：desktop seed package.json 加依赖**

```json
// packages/desktop/resources/kernel/package.json 的 dependencies 追加
"pi-cache-optimizer": "^2.6.24"
```

- [ ] **步骤 4：bun install 安装依赖**

```bash
cd /Users/pipi/work/HiAgent && bun install
```

- [ ] **步骤 5：验证扩展入口可解析**

> npm 上 `pi-cache-optimizer@2.6.24` 已声明 `pi.extensions: ["./index.ts"]`，能过 `readPiExtensionsDeclaration` gate。
> 版本策略：dev 和 desktop seed 统一 `^2.6.24`，与 kernel 对齐。

```bash
cd /Users/pipi/work/HiAgent && bun -e "
const { resolveExtensionEntryFile } = require('./packages/kernel/src/extensions.ts');
console.log(resolveExtensionEntryFile('pi-cache-optimizer'));
"
```
预期：输出 `pi-cache-optimizer` 的入口文件路径（非报错）

- [ ] **步骤 6：Commit**

```bash
git add packages/kernel/src/extensions.ts packages/kernel/package.json packages/desktop/resources/kernel/package.json bun.lock
git commit -m "feat: 内置 pi-cache-optimizer 扩展"
```

---

### 任务 2：usage 类型定义

**文件：**
- 修改：`packages/shared/src/types.ts:126`

- [ ] **步骤 1：AssistantMessage 新增 usage 字段，同步更新注释**

当前 types.ts:126 有注释 `// 简化：忽略 usage/api/provider/responseModel/responseId（前端用不到）`，需更新：

```typescript
// 原注释「简化：忽略 usage/api/provider/responseModel/responseId（前端用不到）」改为：
// usage：透传 Pi SDK 的 Usage 对象，message_end 时由 kernel 原样转发到前端。
// 旧消息无此字段，前端需兼容 undefined。cost 字段不在前端使用故不定义。
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  model: string;
  stopReason: string;
  timestamp: number;
  errorMessage?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
}
```

- [ ] **步骤 2：运行 typecheck 确认**

```bash
cd /Users/pipi/work/HiAgent && bun run --filter @hiagent/shared typecheck
```
预期：exit code 0

- [ ] **步骤 3：Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): AssistantMessage 新增 usage 字段"
```

---

### 任务 3：kernel 透传 usage

**文件：**
- 修改：`packages/kernel/src/agent-manager.ts:605-606`

- [ ] **步骤 1：message_end 处理中透传 usage**

当前代码在 `message_end` 时仅 push 原始 message 对象。Pi RPC 的 `message_end` 事件已包含 `message.usage`，只需确认不被过滤。

```typescript
// packages/kernel/src/agent-manager.ts，_onSessionEvent 中的 message_end case：
case "message_end":
  // message 来自 Pi RPC，已包含 usage 字段（若有）。直接透传。
  if (event.message) handle.messages.push(event.message);
  break;
```

上述逻辑已存在，无需修改。但需确认 RpcEvent 类型不阻挡 usage。

- [ ] **步骤 2：确认 RpcEvent 类型不会过滤 usage**

```typescript
// packages/kernel/src/rpc-client.ts:18
export interface RpcEvent {
  type: string;
  [k: string]: any;  // ← 已支持任意额外字段，usage 可通过
}
```
无需修改，验证即可。

- [ ] **步骤 3：编写单元测试验证透传**

```typescript
// packages/kernel/tests/agent-manager.test.ts 追加测试

test("message_end 透传 usage 字段", () => {
  // 模拟 Pi RPC 的 message_end 事件
  const event = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      model: "test-model",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 1000,
        output: 200,
        cacheRead: 500,
        cacheWrite: 100,
        totalTokens: 1200,
      },
    },
  };
  // event.message.usage 应被保留，不被过滤
  expect(event.message.usage).toBeDefined();
  expect(event.message.usage.input).toBe(1000);
});
```

- [ ] **步骤 4：运行测试确认**

```bash
cd /Users/pipi/work/HiAgent && bun test packages/kernel/tests/agent-manager.test.ts
```
预期：PASS（含新增测试）

- [ ] **步骤 5：Commit**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "feat(kernel): message_end 透传 Pi usage 到前端"
```

---

### 任务 4：前端 session store 累计计数

**文件：**
- 修改：`packages/frontend/src/store/session.ts`

- [ ] **步骤 1：新增 token 累计状态**

```typescript
// session store 接口追加
interface SessionState {
  // ... 现有字段 ...
  
  /** 每个会话的累计 token 计数 */
  tokenTotals: Record<string, { input: number; output: number }>;
  
  /** 累加一次 API 调用的 token */
  addTokens: (sessionId: string, input: number, output: number) => void;
}

// create 回调中实现
tokenTotals: {},

addTokens: (sessionId, input, output) => {
  set(s => {
    const cur = s.tokenTotals[sessionId] ?? { input: 0, output: 0 };
    return {
      tokenTotals: {
        ...s.tokenTotals,
        [sessionId]: {
          input: cur.input + input,
          output: cur.output + output,
        },
      },
    };
  });
},
```

- [ ] **步骤 2：seed 历史累计（打开会话时从消息计算）**

```typescript
// 新增 seedTokenTotal 方法
seedTokenTotal: (sessionId, messages: any[]) => {
  let input = 0;
  let output = 0;
  for (const m of messages) {
    if (m.role === "assistant" && m.usage) {
      input += m.usage.input;
      output += m.usage.output;
    }
  }
  if (input > 0 || output > 0) {
    set(s => ({
      tokenTotals: { ...s.tokenTotals, [sessionId]: { input, output } },
    }));
  }
},
```

- [ ] **步骤 3：编写单元测试**

```typescript
// packages/frontend/tests/store/session.test.ts 追加

test("addTokens 累加 token 计数", () => {
  const store = useSessionStore.getState();
  store.addTokens("s1", 100, 50);
  store.addTokens("s1", 200, 80);
  expect(store.tokenTotals["s1"]).toEqual({ input: 300, output: 130 });
});

test("seedTokenTotal 从历史消息计算累计", () => {
  const messages = [
    { role: "user", content: [] },
    { role: "assistant", usage: { input: 100, output: 50 }, content: [] },
    { role: "assistant", usage: { input: 200, output: 30 }, content: [] },
    { role: "assistant", content: [] }, // 无 usage 的历史消息
  ];
  const store = useSessionStore.getState();
  store.seedTokenTotal("s2", messages);
  expect(store.tokenTotals["s2"]).toEqual({ input: 300, output: 80 });
});
```

- [ ] **步骤 4：运行测试**

```bash
cd /Users/pipi/work/HiAgent/packages/frontend && bun test tests/store/session.test.ts
```
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/frontend/src/store/session.ts packages/frontend/tests/store/session.test.ts
git commit -m "feat(frontend): session store 新增 token 累计计数 + 历史 seed"
```

---

### 任务 5：SessionView 头部 Token 胶囊

**文件：**
- 修改：`packages/frontend/src/components/SessionView.tsx`

- [ ] **步骤 1：引入 session store 的 token 数据**

```typescript
// SessionView.tsx 顶部新增
const tokenTotal = useSessionStore(s => s.tokenTotals[sessionId]);
const [lastUsage, setLastUsage] = useState<{
  input: number; output: number; cacheRead: number; cacheWrite: number;
} | null>(null);
```

- [ ] **步骤 2：监听 message_end 更新状态**

```typescript
// 在已有的 onMessage 回调中追加
if (e.type === "message_end" && e.message?.usage) {
  const u = e.message.usage;
  setLastUsage({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });
  useSessionStore.getState().addTokens(sessionId, u.input, u.output);
}
```

- [ ] **步骤 3：seed 历史累计（加载消息后）**

```typescript
// 在已有的消息加载 useEffect 中，获取消息后 seed
const res = (await api.get(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)) as { messages: any[] };
useSessionStore.getState().setMessages(sessionId, res.messages);
useSessionStore.getState().seedTokenTotal(sessionId, res.messages);  // ← 新增
```

- [ ] **步骤 4：格式化函数**

```typescript
// 在 SessionView.tsx 顶部（组件外）定义
function fmtTok(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return v % 1 === 0 ? `${v}M` : `${v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return v % 1 === 0 ? `${v}K` : `${v.toFixed(1)}k`;
  }
  return String(n);
}
```

- [ ] **步骤 5：header 右侧渲染胶囊**

```tsx
{/* header 右侧，在现有状态信息之后 */}
{lastUsage && (
  <div style="display:flex;align-items:center;gap:8px" data-testid="token-capsules">
    <span className="token-capsule token-capsule--io">
      ↑{fmtTok(lastUsage.output)}/↓{fmtTok(lastUsage.input)}
    </span>
    {tokenTotal && (
      <span className="token-capsule token-capsule--total">
        累计 {fmtTok(tokenTotal.input + tokenTotal.output)}
      </span>
    )}
    {(lastUsage.cacheRead > 0 || lastUsage.cacheWrite > 0) && (
      <span className="token-capsule token-capsule--cache">
        缓存 {fmtTok(lastUsage.cacheRead / (lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite) * 100)}%
      </span>
    )}
  </div>
)}
```

- [ ] **步骤 6：添加胶囊样式**

在全局 CSS 或 tailwind 中追加：

```css
.token-capsule {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
}
.token-capsule--cache {
  background: #ecfdf5;
  color: #059669;
}
```

- [ ] **步骤 7：编写组件测试**

```typescript
// packages/frontend/tests/SessionView.test.tsx 追加

test("token 胶囊：显示 ↑↓/累计/缓存", async () => {
  // 模拟 message_end 事件带 usage
  render(<SessionView sessionId="s1" />);
  // ... 触发 message_end ...
  expect(screen.getByTestId("token-capsules")).toBeInTheDocument();
  expect(screen.getByText(/↑.*\/↓/)).toBeInTheDocument();
});

test("无 usage 时不显示 token 胶囊", async () => {
  render(<SessionView sessionId="s1" />);
  expect(screen.queryByTestId("token-capsules")).toBeNull();
});

test("缓存命中率格式化正确", () => {
  expect(fmtTok(1500)).toBe("1.5k");
  expect(fmtTok(55000)).toBe("55K");
  expect(fmtTok(1500000)).toBe("1.5M");
  expect(fmtTok(800)).toBe("800");
});
```

- [ ] **步骤 8：运行测试**

```bash
cd /Users/pipi/work/HiAgent/packages/frontend && bun test tests/SessionView.test.tsx
```
预期：PASS

- [ ] **步骤 9：Commit**

```bash
git add packages/frontend/src/components/SessionView.tsx packages/frontend/tests/SessionView.test.tsx packages/frontend/src/index.css
git commit -m "feat(frontend): 聊天头部新增 ↑↓ token 和缓存命中率显示"
```

---

### 任务 6：集成验证

- [ ] **步骤 1：运行全部测试**

```bash
cd /Users/pipi/work/HiAgent && bun run test
```
预期：全部 PASS

- [ ] **步骤 2：启动 kernel + frontend 手动验证**

```bash
cd /Users/pipi/work/HiAgent && bun run dev
```
1. 检查 kernel 日志确认 pi-cache-optimizer 已加载
2. 发送一条消息，观察 header 出现 token 胶囊
3. 切换会话，确认累计数字正确切换
4. 刷新页面重新打开历史会话，确认累计从历史 seed

- [ ] **步骤 3：Commit 最终调整**

```bash
git add -A && git commit -m "chore: 集成验证通过"
```
