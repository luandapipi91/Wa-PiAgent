import { useExtensionsStore } from "../../store/extensions";

export function ExtensionSection() {
  const { plugins, togglePlugin } = useExtensionsStore();

  return (
    <div className="flex flex-col gap-2 p-4 overflow-auto">
      <span className="text-xs font-bold text-tertiary uppercase tracking-wide">已启用插件</span>
      {plugins.length === 0 && (
        <span className="text-sm text-tertiary py-2">暂无插件</span>
      )}
      {plugins.map((p) => (
        <div
          key={p.id}
          className="flex items-center gap-2 py-1"
          style={{ opacity: p.enabled ? 1 : 0.5 }}
        >
          <input
            type="checkbox"
            checked={p.enabled}
            onChange={() => togglePlugin(p.id, !p.enabled)}
            data-testid={`ext-checkbox-${p.id}`}
            className="cursor-pointer"
          />
          <div className="flex flex-col">
            <span className="text-sm text-primary" data-testid={`ext-name-${p.id}`}>
              {p.displayName}
              {p.version && <span className="text-xs text-tertiary ml-1">v{p.version}</span>}
              {!p.enabled && <span className="text-xs ml-1" style={{ color: "var(--danger)" }}>[禁用]</span>}
            </span>
            <span className="text-xs text-tertiary">{p.description}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
