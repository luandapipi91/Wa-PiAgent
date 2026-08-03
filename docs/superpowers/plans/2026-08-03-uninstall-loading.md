# 卸载扩展等待反馈 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 给插件管理面板的「卸载」操作补充等待反馈——点击确认卸载后，按钮变为 spinner +「卸载中…」并 disabled，状态由 kernel 事件精确终结（成功重置、失败恢复）。

**架构：** 与现有「升级」模式完全对称：store 新增 `uninstalling: Record<string, boolean>` 状态；`uninstallPackage` 置位，`setAll`（extension:changed 成功）重置，`setError`（extension:error 失败）清除目标条目；卸载按钮读取该状态渲染 loading 态。

**技术栈：** zustand（store）、React + Tailwind + CSS 变量、@testing-library/react + happy-dom（组件测试）、bun:test。

**规格：** `docs/superpowers/specs/2026-08-03-uninstall-loading-design.md`

---

## 文件结构

- 修改 `packages/frontend/src/store/extensions.ts` — 新增 `uninstalling` 状态字段 + 三个动作（置位/重置/清除）
- 修改 `packages/frontend/src/components/settings/ExtensionSection.tsx` — 卸载按钮 loading 态（spinner + disabled）
- 修改 `packages/frontend/tests/extensions-store.test.ts` — store 行为测试（含 beforeEach 加 `uninstalling: {}`）
- 修改 `packages/frontend/tests/ExtensionSection.test.tsx` — 按钮 loading 态组件测试（含 beforeEach 加 `uninstalling: {}`）

---

## 任务 1：store 新增 uninstalling 状态

**文件：**

- 修改：`packages/frontend/src/store/extensions.ts`
- 测试：`packages/frontend/tests/extensions-store.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `packages/frontend/tests/extensions-store.test.ts` 末尾追加（并把 beforeEach 的 setState 补上 `uninstalling: {}`）：

```ts
beforeEach(() => {
  useExtensionsStore.setState({ packages: [], installs: {}, upgrading: {}, uninstalling: {}, error: null });
});
```

```ts
// ===== 卸载反馈（uninstalling 状态）=====

test("uninstallPackage 标记 uninstalling 状态（卸载中）", () => {
  useExtensionsStore.getState().uninstallPackage("foo");
  expect(useExtensionsStore.getState().uninstalling["foo"]).toBe(true);
});

test("setAll（extension:changed）清除 uninstalling（卸载完成）", () => {
  useExtensionsStore.setState({ uninstalling: { foo: true } });
  useExtensionsStore.getState().setAll({
    type: "extension:changed",
    packages: [{ name: "foo", source: "npm", enabled: true }],
  });
  expect(useExtensionsStore.getState().uninstalling["foo"]).toBeUndefined();
});

test("setError 清除 uninstalling 并落到全局 error（卸载失败）", () => {
  useExtensionsStore.setState({ uninstalling: { foo: true } });
  useExtensionsStore.getState().setError({
    type: "extension:error",
    name: "foo",
    error: "卸载失败",
  });
  expect(useExtensionsStore.getState().uninstalling["foo"]).toBeUndefined();
  expect(useExtensionsStore.getState().error).toBe("卸载失败");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行（cwd 为 `packages/frontend`）：`bun test tests/extensions-store.test.ts`
预期：新加的 3 个测试 FAIL（`uninstalling` 未定义 / 动作未实现）

- [ ] **步骤 3：实现 store 变更**

修改 `packages/frontend/src/store/extensions.ts`：

接口 `ExtensionsState` 加字段（`upgrading: UpgradingMap;` 之后）：

```ts
  uninstalling: Record<string, boolean>;
```

初始状态（`upgrading: {},` 之后）：

```ts
  uninstalling: {},
```

`setAll` 改为：

```ts
  // extension:changed / extension:list 回复：更新真实列表，保留占位 installs；
  // changed 由 kernel 在操作（含升级/卸载）成功后推送 → 清除 upgrading/uninstalling 标记
  setAll: (data) => set({ packages: data.packages, upgrading: {}, uninstalling: {}, error: null }),
```

`setError` 在 upgrading 分支之后新增 uninstalling 分支：

```ts
      // 卸载失败：清除 uninstalling 标记 + 落全局 error
      if (s.uninstalling[data.name]) {
        const nextUn = { ...s.uninstalling };
        delete nextUn[data.name];
        return { uninstalling: nextUn, error: data.error };
      }
```

`uninstallPackage` 改为：

```ts
  uninstallPackage: (name) => {
    set((s) => ({ error: null, uninstalling: { ...s.uninstalling, [name]: true } }));
    void api.post("/api/extensions/uninstall", { name });
  },
```

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test tests/extensions-store.test.ts`
预期：全部 PASS（含原有用例，beforeEach 补充的 `uninstalling: {}` 不影响旧断言）

- [ ] **步骤 5：Commit**

```bash
git add packages/frontend/src/store/extensions.ts packages/frontend/tests/extensions-store.test.ts
git commit -m "feat(frontend): 卸载扩展增加 uninstalling 等待状态（store 建模，与升级对称）"
```

---

## 任务 2：卸载按钮 loading 态

**文件：**

- 修改：`packages/frontend/src/components/settings/ExtensionSection.tsx`
- 测试：`packages/frontend/tests/ExtensionSection.test.tsx`

- [ ] **步骤 1：编写失败的测试**

在 `packages/frontend/tests/ExtensionSection.test.tsx` 末尾追加（并把 beforeEach 的 setState 补上 `uninstalling: {}`）：

```tsx
// ===== 卸载反馈（uninstalling 状态）=====

test("卸载中按钮显示「卸载中」且禁用（防止重复点击）", () => {
  useExtensionsStore.setState({ uninstalling: { "superpowers-zh": true } });
  render(<ExtensionSection />);
  const btn = screen.getByTestId("ext-uninstall-superpowers-zh") as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(btn.textContent).toContain("卸载中");
});

test("点击确认卸载后按钮进入卸载中状态", () => {
  render(<ExtensionSection />);
  fireEvent.click(screen.getByTestId("ext-uninstall-superpowers-zh"));
  fireEvent.click(screen.getByTestId("confirm-ok"));
  const btn = screen.getByTestId("ext-uninstall-superpowers-zh") as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(btn.textContent).toContain("卸载中");
});

test("卸载失败后按钮恢复可点（uninstalling 被清除）", () => {
  render(<ExtensionSection />);
  fireEvent.click(screen.getByTestId("ext-uninstall-superpowers-zh"));
  fireEvent.click(screen.getByTestId("confirm-ok"));
  useExtensionsStore.getState().setError({
    type: "extension:error",
    name: "superpowers-zh",
    error: "卸载失败",
  });
  const btn = screen.getByTestId("ext-uninstall-superpowers-zh") as HTMLButtonElement;
  expect(btn.disabled).toBe(false);
  expect(btn.textContent).toBe("卸载");
});
```

（beforeEach 里 setState 补加 `uninstalling: {}`，避免测试间残留。）

- [ ] **步骤 2：运行测试验证失败**

运行（cwd 为 `packages/frontend`）：`bun test tests/ExtensionSection.test.tsx`
预期：新加的 3 个测试 FAIL（按钮无 loading 态 / `uninstalling` 未消费）

- [ ] **步骤 3：实现按钮 loading 态**

修改 `packages/frontend/src/components/settings/ExtensionSection.tsx`：

从 store 解构处（`upgrading,` 之后）加：

```tsx
    uninstalling,
```

卸载按钮（当前 `onClick={() => setConfirmUninstall(pkg.name)}` 的 `<button>`）替换为：

```tsx
                <button
                  className="px-2 py-1 text-xs rounded-sm font-medium disabled:opacity-60"
                  style={{ background: "#fff", color: "var(--danger)", border: "1px solid var(--danger)" }}
                  onClick={() => setConfirmUninstall(pkg.name)}
                  disabled={uninstalling[pkg.name] === true}
                  data-testid={`ext-uninstall-${pkg.name}`}
                >
                  {uninstalling[pkg.name] ? (
                    <span className="inline-flex items-center gap-1">
                      <span
                        className="inline-block w-3 h-3 rounded-full"
                        style={{
                          border: "2px solid var(--danger-soft)",
                          borderTopColor: "var(--danger)",
                          animation: "spin 0.8s linear infinite",
                        }}
                      />
                      卸载中…
                    </span>
                  ) : (
                    "卸载"
                  )}
                </button>
```

（`spin` 动画已定义于 `styles.css`，复用现有 spinner 模式；disabled 样式沿用升级按钮的 `disabled:opacity-60`。）

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test tests/ExtensionSection.test.tsx`
预期：全部 PASS

- [ ] **步骤 5：全量回归 + Commit**

运行：`bun run typecheck`（cwd 为 `packages/frontend`）
预期：tsc --noEmit 无错误

```bash
git add packages/frontend/src/components/settings/ExtensionSection.tsx packages/frontend/tests/ExtensionSection.test.tsx
git commit -m "feat(frontend): 卸载按钮加载态——spinner +「卸载中…」+ disabled，等待 kernel 事件终结"
```

---

## 收尾

- [ ] **更新 CHANGELOG.md**：在顶部 `## 2026-08-03` 下新增一条（fix 类型），记录卸载等待反馈，影响范围 `packages/frontend/src/store/extensions.ts`、`packages/frontend/src/components/settings/ExtensionSection.tsx`、两个测试文件，验证方式（store 单测 + 组件测试）。

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录卸载等待反馈"
```

- [ ] **手工验证**（可选）：运行 `bun run dev` 打开设置 → 插件面板，卸载一个已装插件，确认按钮转圈「卸载中…」→ 完成后卡片消失。
