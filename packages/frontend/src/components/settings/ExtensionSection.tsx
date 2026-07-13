// packages/frontend/src/components/settings/ExtensionSection.tsx
import { useState } from "react";
import { useExtensionsStore } from "../../store/extensions";
import { ConfirmDialog } from "../ui/ConfirmDialog";

export function ExtensionSection() {
  const {
    packages,
    error,
    installPackage,
    uninstallPackage,
    upgradePackage,
    togglePackage,
  } = useExtensionsStore();

  const [inputValue, setInputValue] = useState("");
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  const handleInstall = () => {
    const name = inputValue.trim();
    if (!name) return;
    setInstalling(true);
    installPackage(name);
    setInputValue("");
    // 安装结果通过 WS extension:changed 异步返回
    setTimeout(() => setInstalling(false), 2000);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleInstall();
  };

  return (
    <div className="flex flex-col gap-4 p-4 overflow-auto">
      {/* 安装区域 */}
      <div>
        <span className="text-xs font-bold text-tertiary uppercase tracking-wide">安装新插件</span>
        <div className="flex gap-2 mt-2">
          <input
            className="flex-1 px-3 py-2 text-sm border border-hairline rounded-sm bg-surface text-primary placeholder:text-tertiary focus:outline-none focus:border-accent"
            style={{ boxShadow: "none" }}
            placeholder="npm 包名 (如 superpowers-zh 或 npm:superpowers-zh)…"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={installing}
            data-testid="ext-install-input"
          />
          <button
            className="px-4 py-2 text-sm font-semibold rounded-sm text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
            onClick={handleInstall}
            disabled={installing || !inputValue.trim()}
            data-testid="ext-install-btn"
          >
            {installing ? "安装中…" : "安装"}
          </button>
        </div>
      </div>

      <div style={{ height: "1px", background: "var(--hairline)" }} />

      {/* 错误提示 */}
      {error && (
        <div className="px-3 py-2 rounded-sm text-sm" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {/* 已安装插件列表 */}
      <div>
        <span className="text-xs font-bold text-tertiary uppercase tracking-wide">
          已安装插件 · {packages.length}
        </span>

        {packages.length === 0 && (
          <p className="text-sm text-tertiary py-4">暂无插件，输入上方包名开始安装</p>
        )}

        <div className="flex flex-col gap-2 mt-2">
          {packages.map((pkg) => (
            <div
              key={pkg.name}
              className="flex items-start gap-3 p-3 rounded-sm border border-hairline"
              style={{ opacity: pkg.enabled ? 1 : 0.55 }}
              data-testid={`ext-card-${pkg.name}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-primary">{pkg.name}</span>
                  {pkg.version && (
                    <span className="text-xs px-1.5 py-0.5 rounded text-secondary" style={{ background: "var(--surface-elevated)" }}>
                      v{pkg.version}
                    </span>
                  )}
                  {pkg.latestVersion && pkg.enabled && (
                    <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: "var(--warning-soft)", color: "var(--warning)" }}>
                      v{pkg.latestVersion} 可用
                    </span>
                  )}
                  {pkg.source !== "npm" && (
                    <span className="text-xs px-1.5 py-0.5 rounded text-secondary" style={{ background: "var(--surface-elevated)" }}>
                      {pkg.source}
                    </span>
                  )}
                </div>
                {pkg.description && (
                  <p className="text-xs text-secondary mt-1 line-clamp-1">{pkg.description}</p>
                )}

                {/* 启用/禁用开关：onClick 绑在 <label> 上，文字点击也能切换 */}
                <label
                  className="flex items-center gap-2 mt-2 cursor-pointer"
                  style={{ width: "fit-content" }}
                  onClick={() => togglePackage(pkg.name, !pkg.enabled)}
                  data-testid={`ext-toggle-${pkg.name}`}
                >
                  <span
                    className="relative inline-block rounded-full transition-colors"
                    style={{
                      width: 38,
                      height: 22,
                      background: pkg.enabled ? "var(--success)" : "#cbd5e1",
                    }}
                  >
                    <span
                      className="absolute top-0.5 rounded-full bg-white transition-all"
                      style={{
                        width: 18,
                        height: 18,
                        left: pkg.enabled ? undefined : 2,
                        right: pkg.enabled ? 2 : undefined,
                        boxShadow: "0 1px 2px rgba(0,0,0,.1)",
                      }}
                    />
                  </span>
                  <span
                    className="text-xs"
                    style={{ color: pkg.enabled ? "var(--success)" : "var(--text-tertiary)" }}
                  >
                    {pkg.enabled ? "已启用" : "已禁用"}
                  </span>
                </label>
              </div>

              {/* 操作按钮 */}
              <div className="flex gap-1.5 flex-shrink-0">
                {pkg.enabled && pkg.latestVersion && pkg.source === "npm" && (
                  <button
                    className="px-2 py-1 text-xs rounded-sm font-medium"
                    style={{ background: "var(--warning-soft)", color: "var(--warning)", border: "1px solid #fcd34d" }}
                    onClick={() => upgradePackage(pkg.name)}
                    data-testid={`ext-upgrade-${pkg.name}`}
                  >
                    ⬆ 升级
                  </button>
                )}
                <button
                  className="px-2 py-1 text-xs rounded-sm font-medium"
                  style={{ background: "var(--danger-soft)", color: "var(--danger)", border: "1px solid #fca5a5" }}
                  onClick={() => setConfirmUninstall(pkg.name)}
                  data-testid={`ext-uninstall-${pkg.name}`}
                >
                  🗑 卸载
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 底部提示 */}
      <div className="px-3 py-2.5 rounded-sm text-xs text-secondary" style={{ background: "var(--surface-elevated)", border: "1px solid var(--hairline)" }}>
        💡 安装、卸载、升级操作将在 <strong>下次对话开始时生效</strong>，当前对话不受影响。
      </div>

      {/* 卸载确认弹窗 */}
      {confirmUninstall && (
        <ConfirmDialog
          title="确认卸载"
          message={`确定要卸载 ${confirmUninstall} 吗？已禁用的插件不会影响下次对话。`}
          confirmText="卸载"
          danger
          onConfirm={() => {
            uninstallPackage(confirmUninstall);
            setConfirmUninstall(null);
          }}
          onCancel={() => setConfirmUninstall(null)}
        />
      )}
    </div>
  );
}
