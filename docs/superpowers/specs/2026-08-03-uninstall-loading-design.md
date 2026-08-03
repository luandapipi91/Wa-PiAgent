# 设计：卸载扩展的等待反馈（按钮级 loading）

**日期**：2026-08-03
**状态**：已批准（用户确认按钮级方案）
**范围**：前端——`packages/frontend/src/store/extensions.ts`、`packages/frontend/src/components/settings/ExtensionSection.tsx`

---

## 1. 问题

插件管理面板中，点击「卸载」→ 确认弹窗关闭后，前端**没有任何等待反馈**：按钮不 disabled、无 spinner、无进度，用户看到的是"点了就干等"，直到 `extension:changed` 到来卡片消失（成功）或 `extension:error` 到来出现红字（失败）。`bun remove` 实际要跑 1~数 秒，这段时间的空白感让用户以为卡死。

对比：**安装**已有占位卡 + 不定进度条 + 流式日志；**升级**已有按钮 disabled + "⟳ 升级中…" + 流式进度。**卸载是三个操作中唯一没有状态建模的**（store 无 `uninstalling` 字段，kernel 侧 `NpmPackageService.uninstall` 也不回推进度）。

## 2. 目标

- 卸载等待期间：卸载按钮显示 spinner +「卸载中…」并 disabled，阻止重复点击
- 状态由 kernel 事件精确终结：成功（`extension:changed`）重置、失败（`extension:error`）恢复按钮可点
- 实现与现有「升级」模式完全对称，不引入新机制

## 3. 非目标

- 不做卡片级遮罩 / 淡出动画（用户选择按钮级）
- 不改 kernel 侧 `NpmPackageService.uninstall`（不流式回推进度，避免后端改动）
- 不加 toast（现有错误横幅机制已覆盖失败提示）

## 4. 方案

### 4.1 store（`store/extensions.ts`）

新增状态：`uninstalling: Record<string, boolean>`（初始 `{}`）。

- `uninstallPackage(name)`：先置位再发请求（保持 fire-and-forget）：

  ```ts
  uninstallPackage: (name) => {
    set((s) => ({ error: null, uninstalling: { ...s.uninstalling, [name]: true } }));
    void api.post("/api/extensions/uninstall", { name });
  },
  ```

- `setAll`（成功事件 `extension:changed`）：重置 `uninstalling: {}`（与现有 `upgrading: {}` 重置同位置）。
- `setError`（失败事件 `extension:error`）：清除 `uninstalling[name]`，让按钮恢复可点，同时落入现有错误横幅逻辑。

### 4.2 按钮（`ExtensionSection.tsx`）

卸载按钮：`disabled={!!uninstalling[pkg.name]}`，等待时渲染 spinner +「卸载中…」：

- spinner 复用全局 `@keyframes spin`（`styles.css` 已有），样式对齐现有 spinner 示例（`border: 2px solid var(--accent-soft); borderTopColor: var(--accent)`）
- disabled 样式沿用升级按钮约定 `disabled:opacity-60`
- 确认弹窗 `onConfirm` 行为不变：立即关闭弹窗 → store 置位 → 按钮转圈

## 5. 数据流

```
点击卸载 → ConfirmDialog onConfirm → uninstallPackage(name)
  → set uninstalling[name]=true → 按钮 spinner +「卸载中…」+ disabled
  → POST /api/extensions/uninstall（kernel 执行 bun remove）
  → 成功：broadcast extension:changed → setAll → uninstalling={} → 卡片消失
  → 失败：broadcast extension:error → setError → 清除 uninstalling[name] → 按钮恢复 + 红字横幅
```

## 6. 测试

- store 单测：`uninstallPackage` 置位 `uninstalling`；`setAll` 重置；`setError` 清除目标条目
- 组件测试（ExtensionSection）：点击卸载确认后按钮 disabled 且含「卸载中…」；卸载失败后按钮恢复可点
- 手工验证：真实卸载一个有依赖的包，观察按钮 loading → 列表刷新

## 7. 影响范围

- `packages/frontend/src/store/extensions.ts`
- `packages/frontend/src/components/settings/ExtensionSection.tsx`
- 新增/更新对应测试文件

（说明：前端测试存在 717 个 happy-dom/bun 环境导致的预存在失败，与本次改动无关；本任务的测试按组件测试层独立运行验证。）
