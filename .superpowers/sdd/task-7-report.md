# Task 7 Report — SessionStore（读写 sessions/<id>.json）

## 状态
✅ 完成

## Commit
- Hash: `b6da2860a5009884fcc7f892905869b441765095`
- Message: `feat(kernel): SessionStore 读写 sessions/<id>.json（消息+委派事件）`
- Files: `packages/kernel/src/session-store.ts`（新建）、`packages/kernel/tests/session-store.test.ts`（新建）

## 测试摘要
```
bun test packages/kernel/tests/session-store.test.ts
 3 pass, 0 fail, 6 expect() calls

(pass) appendMessage 持久化并可读回 [3.27ms]
(pass) loadMessages 不存在返回空 [0.48ms]
(pass) appendAsk + resolveAsk [2.98ms]
```

回归检查：`bun test packages/kernel/` → **17 pass, 0 fail**（4 文件，含原有 agent-md / config-store / project-store，无回归）。

TDD 流程已验证：先写测试 → FAIL（`Cannot find module '../src/session-store'`）→ 写实现 → 3 passed。

## 实现要点
- `SessionStore` 类：`loadMessages` / `appendMessage` / `loadAsks` / `appendAsk` / `resolveAsk`，构造器接受可选 `dir`（默认 `SESSIONS_DIR`），测试用临时目录注入。
- 每个 session 独立文件 `<dir>/<sessionId>.json`，结构 `{ messages: ChatMessage[], intercomEvents: AskItem[] }`。
- `read` 用 try/catch，文件不存在/解析失败返回 `emptySession()`（即 `loadMessages` 对不存在 session 返回 `[]`）。
- `write` 先 `mkdir({ recursive: true })` 确保目录存在。
- `resolveAsk` 按 `messageId` 查找，命中则置 `resolved=true` + `resolvedAt=Date.now()`，未命中静默跳过。

## Concerns
1. **`emptySession()` 工厂函数（非 const EMPTY）**：严格照抄 brief。理由：模块级 `const EMPTY + {...EMPTY}` 浅拷贝会让 `messages`/`intercomEvents` 数组跨实例共享，`push` 会污染后续调用（Task 6 ProjectStore 已踩此坑）。本 Task 的 `read()` 路径实际上每次都 `new` 对象（非 spread 默认值），未直接命中该陷阱，但工厂形式更安全且符合 brief 意图，未做"优化"。
2. **迁移函数 `migrateLegacySessions` 未实现**：brief 的 Interfaces 区列了该签名（老用户首次启动 / Task 33 用），但 Step 1–5 的代码块与测试均未涉及，且无对应测试。按 TDD 约束（"照抄 brief"、3 passed），未臆造实现。如后续 Task 33 需要，应配套测试再补。
3. **`resolveAsk` 未命中无反馈**：当前对不存在的 `askMessageId` 静默返回。brief 实现即如此，符合"幂等更新"语义；若上层需要区分"已解决 vs 不存在"，需另议（当前无此测试需求）。
4. **CRLF warning**：Git 提示 LF 将在下次 checkout 转为 CRLF（Windows），不影响测试结果，项目无强制行尾配置。
5. **工作区残留**：`docs/superpowers/plans/...mvp.md` 有未提交修改（非本 Task 范围，未动）。
