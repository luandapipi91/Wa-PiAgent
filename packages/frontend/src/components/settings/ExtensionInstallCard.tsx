import type { InstallEntry } from "../../store/extensions";

interface ExtensionInstallCardProps {
  entry: InstallEntry;
  onRetry: (name: string) => void;
  onRemove: (name: string) => void;
}

/**
 * 安装占位卡片：安装中（不定进度条 + 流式日志行）或安装失败（错误信息 + 重试/移除）。
 * 成功后由 ExtensionSection 父级移除此卡，真实卡片由 extension:changed 提供的 packages 渲染。
 */
export function ExtensionInstallCard({ entry, onRetry, onRemove }: ExtensionInstallCardProps) {
  const { name, status, error, progress } = entry;
  const isInstalling = status === "installing";

  return (
    <div
      className="flex items-start gap-3 p-3 rounded-sm border"
      style={{
        borderColor: isInstalling ? "var(--accent)" : "var(--danger)",
        background: isInstalling ? "var(--accent-soft)" : "var(--danger-soft)",
      }}
      data-testid={`ext-install-card-${name}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-primary">{name}</span>
          <span
            className="text-xs px-1.5 py-0.5 rounded font-medium"
            style={{
              background: isInstalling ? "var(--accent-soft)" : "var(--danger-soft)",
              color: isInstalling ? "var(--accent)" : "var(--danger)",
            }}
            data-testid={`ext-install-status-${name}`}
          >
            {isInstalling ? "安装中…" : "安装失败"}
          </span>
        </div>

        {isInstalling ? (
          <div className="mt-2">
            {/* 不定进度条：包管理器输出无确定百分比，仅做活动指示 */}
            <div
              className="relative overflow-hidden rounded-full"
              style={{ height: 4, background: "var(--hairline)" }}
            >
              <span
                className="ext-install-bar absolute top-0 h-full rounded-full"
                style={{ width: "40%", background: "var(--accent)" }}
              />
            </div>
            <p
              className="text-xs text-secondary mt-1 line-clamp-1 font-mono"
              data-testid={`ext-install-progress-${name}`}
            >
              {progress ?? "正在安装…"}
            </p>
          </div>
        ) : (
          <p
            className="text-xs mt-1 line-clamp-2"
            style={{ color: "var(--danger)" }}
            data-testid={`ext-install-progress-${name}`}
          >
            {error ?? "安装失败"}
          </p>
        )}
      </div>

      {!isInstalling && (
        <div className="flex gap-1.5 flex-shrink-0">
          <button
            className="px-2 py-1 text-xs rounded-sm font-medium text-white"
            style={{ background: "var(--accent)" }}
            onClick={() => onRetry(name)}
            data-testid={`ext-retry-${name}`}
          >
            ↻ 重试
          </button>
          <button
            className="px-2 py-1 text-xs rounded-sm font-medium"
            style={{ background: "var(--danger-soft)", color: "var(--danger)", border: "1px solid var(--danger)" }}
            onClick={() => onRemove(name)}
            data-testid={`ext-remove-${name}`}
          >
            🗑 移除
          </button>
        </div>
      )}
    </div>
  );
}
