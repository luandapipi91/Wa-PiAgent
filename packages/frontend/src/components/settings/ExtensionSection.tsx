// packages/frontend/src/components/settings/ExtensionSection.tsx
import { useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { useExtensionsStore } from "../../store/extensions";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { CommandListModal } from "./CommandListModal";
import { ExtensionInstallCard } from "./ExtensionInstallCard";

export function ExtensionSection() {
  const {
    packages,
    installs,
    upgrading,
    uninstalling,
    error,
    installPackage,
    uninstallPackage,
    upgradePackage,
    togglePackage,
    retryInstall,
    removeInstall,
  } = useExtensionsStore();
  const { t } = useTranslation();

  const [inputValue, setInputValue] = useState("");
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [commandModalPkg, setCommandModalPkg] = useState<string | null>(null);

  const handleInstall = () => {
    const name = inputValue.trim();
    if (!name) return;
    installPackage(name);
    setInputValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleInstall();
  };

  const installEntries = Object.values(installs);

  return (
    <div className="flex flex-col gap-4 p-4 overflow-auto">
      {/* 安装区域 */}
      <div>
        <span className="text-xs font-bold text-tertiary uppercase tracking-wide">{t("settings.extension.installTitle")}</span>
        <div className="flex gap-2 mt-2">
          <input
            className="flex-1 px-3 py-2 text-sm border border-hairline rounded-sm bg-surface text-primary placeholder:text-tertiary focus:outline-none focus:border-accent"
            style={{ boxShadow: "none" }}
            placeholder={t("settings.extension.installPlaceholder")}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            data-testid="ext-install-input"
          />
          <button
            className="px-4 py-2 text-sm font-semibold rounded-sm text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
            onClick={handleInstall}
            disabled={!inputValue.trim()}
            data-testid="ext-install-btn"
          >
            {t("settings.extension.install")}
          </button>
        </div>
      </div>

      <div style={{ height: "1px", background: "var(--hairline)" }} />

      {/* 错误提示（卸载/升级等非安装失败的兜底提示） */}
      {error && (
        <div className="px-3 py-2 rounded-sm text-sm" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {/* 插件列表 */}
      <div>
        <span className="text-xs font-bold text-tertiary uppercase tracking-wide">
          {t("settings.extension.installedTitle", { count: packages.length })}
        </span>

        {packages.length === 0 && installEntries.length === 0 && (
          <p className="text-sm text-tertiary py-4">{t("settings.extension.empty")}</p>
        )}

        <div className="flex flex-col gap-2 mt-2">
          {/* 占位卡：安装中 / 安装失败 —— 渲染在最顶部 */}
          {installEntries.map((entry) => (
            <ExtensionInstallCard
              key={`install-${entry.name}`}
              entry={entry}
              onRetry={retryInstall}
              onRemove={removeInstall}
            />
          ))}

          {/* 真实已安装卡片 */}
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
                      {t("settings.extension.versionAvailable", { version: pkg.latestVersion })}
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

                {/* 升级中：流式显示包管理器进度行 */}
                {upgrading[pkg.name] !== undefined && (
                  <p
                    className="text-xs mt-1 line-clamp-1 font-mono"
                    style={{ color: "var(--warning)" }}
                    data-testid={`ext-upgrade-progress-${pkg.name}`}
                  >
                    {upgrading[pkg.name] || t("settings.extension.upgrading")}
                  </p>
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
                    {pkg.enabled ? t("settings.extension.enabled") : t("settings.extension.disabled")}
                  </span>
                </label>
              </div>

              {/* 操作按钮 */}
              <div className="flex gap-1.5 flex-shrink-0">
                {pkg.enabled && pkg.latestVersion && pkg.source === "npm" && (
                  <button
                    className="px-2 py-1 text-xs rounded-sm font-medium disabled:opacity-60"
                    style={{ background: "var(--warning-soft)", color: "var(--warning)", border: "1px solid #fcd34d" }}
                    onClick={() => upgradePackage(pkg.name)}
                    disabled={upgrading[pkg.name] !== undefined}
                    data-testid={`ext-upgrade-${pkg.name}`}
                  >
                    {upgrading[pkg.name] !== undefined ? t("settings.extension.upgradingBtn") : t("settings.extension.upgrade")}
                  </button>
                )}
                <button
                  className="px-2 py-1 text-xs rounded-sm font-medium"
                  style={{ background: "var(--surface-elevated)", color: "var(--text-primary)", border: "1px solid var(--hairline)" }}
                  onClick={() => setCommandModalPkg(pkg.name)}
                  data-testid={`ext-commands-${pkg.name}`}
                >
                  {t("settings.extension.commands")}
                </button>
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
                      {t("settings.extension.uninstalling")}
                    </span>
                  ) : (
                    t("settings.extension.uninstall")
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 底部提示 */}
      <div className="px-3 py-2.5 rounded-sm text-xs text-secondary" style={{ background: "var(--surface-elevated)", border: "1px solid var(--hairline)" }}>
        {t("settings.extension.hintPrefix")}<strong>{t("settings.extension.hintHighlight")}</strong>{t("settings.extension.hintSuffix")}
      </div>

      {/* 附加命令弹窗 */}
      {commandModalPkg && (
        <CommandListModal
          packageName={commandModalPkg}
          onClose={() => setCommandModalPkg(null)}
        />
      )}

      {/* 卸载确认弹窗 */}
      {confirmUninstall && (
        <ConfirmDialog
          title={t("settings.extension.confirmUninstallTitle")}
          message={t("settings.extension.confirmUninstallMessage", { name: confirmUninstall })}
          confirmText={t("settings.extension.confirmUninstall")}
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
