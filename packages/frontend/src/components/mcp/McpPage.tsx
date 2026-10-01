import { useEffect, useState, type CSSProperties } from "react";
import { SYSTEM_PROJECT_ID } from "@wa-pi/shared";
import { useMcpStore, type McpServerEntry, type McpSaveResult } from "../../store/mcp";
import { useProjectsStore } from "../../store/projects";
import { McpCard } from "./McpCard";
import { McpEmpty } from "./McpEmpty";
import { McpFormModal } from "./McpFormModal";
import { McpToolsModal } from "./McpToolsModal";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useTranslation } from "../../i18n/useTranslation";
import type { McpServerConfig } from "@wa-pi/shared";

export function McpPage() {
  const { t } = useTranslation();
  const {
    servers,
    serverStatuses,
    toolCounts,
    toolsCache,
    loadingTools,
    testingServers,
    errors,
    loginStates,
    stale,
    note,
    selectedProjectId,
    projectScopeEnabled,
    searchQuery,
    loading,
    load,
    save,
    deleteServer,
    testConnection,
    listTools,
    login,
    logout,
    setProjectMcpScope,
    loadProjectScope,
    setSelectedProjectId,
    setSearchQuery,
  } = useMcpStore();

  const projects = useProjectsStore((s) => s.projects);

  const [formOpen, setFormOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerConfig | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showToolsFor, setShowToolsFor] = useState<string | null>(null);
  const [scopePending, setScopePending] = useState(false);

  // 加载列表
  useEffect(() => {
    load(selectedProjectId ?? undefined);
  }, [selectedProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 项目级开关的初值来自 trust.json 的**真值回读**（不靠 pi 的 note 反推：项目还没有
  // .pi/mcp.json 时没有 note，靠 note 会把「未设置」显示成「已开」，而受信是安全决定）。
  // 默认工作区没有项目级作用域（kernel 写侧 400），不读。
  useEffect(() => {
    if (!selectedProjectId || selectedProjectId === SYSTEM_PROJECT_ID) return;
    void loadProjectScope(selectedProjectId);
  }, [selectedProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 搜索过滤
  const filtered = servers.filter(
    (s) =>
      !searchQuery || s.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const openAddForm = () => {
    setEditingServer(null);
    setFormOpen(true);
  };
  const openEditForm = (server: McpServerConfig) => {
    setEditingServer(server);
    setFormOpen(true);
  };
  const closeForm = () => {
    setFormOpen(false);
    setEditingServer(null);
  };

  const handleFormSave = async (
    config: McpServerConfig,
    originalName?: string,
  ): Promise<McpSaveResult> => {
    const result = await save(config, selectedProjectId ?? undefined, originalName);
    // 保存成功才关闭：400 的字段级错误要留在表单里让用户改
    if (result.ok) closeForm();
    return result;
  };

  const handleTest = (serverName: string) => {
    testConnection(serverName, selectedProjectId ?? undefined);
  };

  const handleLogin = (serverName: string, timeoutSec?: number) => {
    login(serverName, timeoutSec, selectedProjectId ?? undefined);
  };

  const handleLogout = (serverName: string) => {
    void logout(serverName, selectedProjectId ?? undefined);
  };

  const handleViewTools = (serverName: string) => {
    // 实时取最新工具列表（force 读 pi 状态，不依赖缓存）
    listTools(serverName, selectedProjectId ?? undefined);
    setShowToolsFor(serverName);
  };

  const handleDelete = (serverName: string) => {
    void deleteServer(serverName, selectedProjectId ?? undefined);
    setConfirmDelete(null);
  };

  // 默认工作区（__system__）不支持项目级 MCP：kernel 直接 400，故此处禁用开关
  const isSystemProject = selectedProjectId === SYSTEM_PROJECT_ID;
  const handleProjectScopeToggle = (enabled: boolean) => {
    if (!selectedProjectId || isSystemProject) return;
    setScopePending(true);
    void setProjectMcpScope(selectedProjectId, enabled).finally(() =>
      setScopePending(false),
    );
  };

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden"
      data-testid="mcp-page"
    >
      {/* 标题栏 */}
      <div
        className="flex items-center px-5 py-3.5"
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        <h2 className="text-base font-extrabold text-primary m-0">
          {t("mcp.pageTitle")}
        </h2>
      </div>

      {/* 工具栏 */}
      <div
        className="flex items-center gap-2.5 px-5 py-2.5"
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--hairline)",
        }}
      >
        {/* 作用域下拉 */}
        <ScopeDropdown
          selectedProjectId={selectedProjectId}
          projects={projects}
          onSelect={(projectId) => setSelectedProjectId(projectId)}
          projectScope={{
            // 真值：true/false 来自 trust.json；null = 未设置（跟随上层，UI 不显示「已开」）
            value: projectScopeEnabled,
            disabled: isSystemProject,
            pending: scopePending,
            onToggle: handleProjectScopeToggle,
          }}
        />

        {/* 搜索 */}
        <input
          className="flex-1 text-[calc(12px*var(--font-scale))] px-3 py-1.5 rounded-lg min-w-0"
          style={{
            background: "var(--canvas)",
            border: "1px solid var(--hairline)",
            color: "var(--text-primary)",
          }}
          placeholder={t("mcp.searchPlaceholder")}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          data-testid="mcp-search"
        />

        {/* 添加按钮：点击弹出模态表单 */}
        <button
          onClick={openAddForm}
          className="text-[calc(11px*var(--font-scale))] font-semibold px-3 py-1.5 rounded-md text-white shrink-0"
          style={{ background: "var(--accent)", border: "none" }}
          data-testid="mcp-add-button"
        >
          {t("mcp.addButton")}
        </button>
      </div>

      {/* 状态未知 / 未受信提示 */}
      {stale && (
        <div
          className="px-5 py-2 text-[calc(11.5px*var(--font-scale))]"
          style={{ background: "var(--warning-soft)", color: "var(--warning)" }}
          data-testid="mcp-stale-banner"
        >
          {t("mcp.statusStale")}
        </div>
      )}
      {note && (
        <div
          className="px-5 py-2 text-[calc(11.5px*var(--font-scale))]"
          style={{ background: "var(--warning-soft)", color: "var(--warning)" }}
          data-testid="mcp-note-banner"
          title={note}
        >
          {t("mcp.untrustedNote")}
        </div>
      )}

      {/* 列表内容 */}
      <div className="flex-1 overflow-y-auto px-5 py-3.5">
        {loading ? (
          <div className="text-center text-tertiary text-[calc(12.5px*var(--font-scale))] py-8">
            {t("mcp.loading")}
          </div>
        ) : filtered.length === 0 ? (
          <McpEmpty />
        ) : (
          filtered.map((s) => {
            const state = effectiveState(s, { stale, serverStatuses });
            return (
              <McpCard
                key={s.name}
                config={s}
                state={state}
                toolCount={toolCounts[s.name] ?? s.tools?.length}
                testing={!!testingServers[s.name]}
                error={
                  errors[s.name] ?? (state === "failed" ? s.error : undefined)
                }
                signedIn={s.signedIn}
                loginState={loginStates[s.name]}
                onTest={() => handleTest(s.name)}
                onViewTools={() => handleViewTools(s.name)}
                onEdit={() => openEditForm(s)}
                onDelete={() => setConfirmDelete(s.name)}
                onLogin={(timeoutSec) => handleLogin(s.name, timeoutSec)}
                onLogout={() => handleLogout(s.name)}
              />
            );
          })
        )}
      </div>

      {/* 新增/编辑表单 Modal */}
      {formOpen && (
        <McpFormModal
          initial={editingServer ?? undefined}
          onSave={handleFormSave}
          onClose={closeForm}
        />
      )}

      {/* 工具列表 Modal */}
      {showToolsFor && (
        <McpToolsModal
          serverName={showToolsFor}
          tools={toolsCache[showToolsFor] ?? []}
          loading={!!loadingTools[showToolsFor]}
          onClose={() => setShowToolsFor(null)}
        />
      )}

      {/* 删除确认弹窗 */}
      {confirmDelete && (
        <ConfirmDialog
          title={t("mcp.deleteTitle")}
          message={t("mcp.deleteMessage", { name: confirmDelete })}
          confirmText={t("common.delete")}
          danger
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

/**
 * 卡片生效状态：本次会话内的测试结果优先（用户刚点的，最新），否则用清单里 pi 报的原始 state。
 *
 *  - stale（清单是上一条缓存）→ 一律「状态未知」，不把可能过期的连接态当成最新
 *  - 测试得到的 `disconnected` 只可能来自 pi 的 `disabled`（kernel test 路由的映射）→ 保持「已停用」
 */
function effectiveState(
  entry: McpServerEntry,
  s: {
    stale: boolean;
    serverStatuses: Record<string, "disconnected" | "connected" | "error">;
  },
): string | undefined {
  if (s.stale) return undefined;
  const tested = s.serverStatuses[entry.name];
  if (tested === "connected") return "connected";
  if (tested === "error") return "failed";
  if (tested === "disconnected") return "disabled";
  return entry.state;
}

// —— 作用域下拉（复用 MemoryPage 的 MemoryScopeDropdown 模式）——

function ScopeDropdown({
  selectedProjectId,
  projects,
  onSelect,
  projectScope,
}: {
  selectedProjectId: string | null;
  projects: { id: string; name: string }[];
  onSelect: (projectId: string | null) => void;
  /** 项目级 MCP 作用域开关（选中具体项目时出现；默认工作区置灰） */
  projectScope: {
    /** trust.json 的真值：null = 未显式设置（跟随上层） */
    value: boolean | null;
    disabled: boolean;
    pending: boolean;
    onToggle: (enabled: boolean) => void;
  };
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const isGlobal = selectedProjectId === null;
  const scopeOn = projectScope.value === true;
  const scopeUnset = projectScope.value === null;

  const label = isGlobal
    ? t("mcp.globalScope")
    : (projects.find((p) => p.id === selectedProjectId)?.name ??
      t("common.scopeProject"));

  const itemStyle = (active: boolean): CSSProperties => ({
    color: active ? "var(--accent)" : "var(--text-primary)",
    background: active ? "var(--accent-soft)" : "transparent",
  });

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[calc(11.5px*var(--font-scale))] px-2.5 py-1.5 rounded-md"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--hairline)",
          color: "var(--text-primary)",
        }}
        data-testid="mcp-scope-select"
      >
        {label}
        <span className="text-[calc(9px*var(--font-scale))] opacity-70">▾</span>
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            data-testid="mcp-scope-backdrop"
            onClick={() => setOpen(false)}
          />
          <div
            className="absolute left-0 z-20 mt-1 py-1 rounded-md min-w-[148px] shadow-lg"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--hairline)",
            }}
            data-testid="mcp-scope-menu"
          >
            <button
              type="button"
              onClick={() => {
                onSelect(null);
                setOpen(false);
              }}
              className="block w-full text-left text-[calc(11.5px*var(--font-scale))] px-3 py-1.5"
              style={itemStyle(isGlobal)}
              data-testid="mcp-scope-option-global"
            >
              {t("mcp.globalScope")}
            </button>
            {projects.length > 0 && (
              <div
                className="my-1"
                style={{ borderTop: "1px solid var(--hairline)" }}
              />
            )}
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onSelect(p.id);
                  setOpen(false);
                }}
                className="block w-full text-left text-[calc(11.5px*var(--font-scale))] px-3 py-1.5 truncate"
                style={itemStyle(selectedProjectId === p.id)}
                data-testid={`mcp-scope-option-project-${p.id}`}
                title={p.name}
              >
                {t("mcp.projectOption", { name: p.name })}
              </button>
            ))}

            {/* 项目级 MCP 作用域开关：选中具体项目时才出现 */}
            {selectedProjectId !== null && (
              <>
                <div
                  className="my-1"
                  style={{ borderTop: "1px solid var(--hairline)" }}
                />
                <div
                  className="flex items-center justify-between gap-3 px-3 py-1.5"
                  data-testid="mcp-project-scope-row"
                  title={
                    projectScope.disabled
                      ? t("kernelMsg.mcp.systemProject")
                      : t("mcp.projectScopeHint")
                  }
                >
                  <span
                    className="flex flex-col"
                    style={{
                      color: projectScope.disabled
                        ? "var(--text-tertiary)"
                        : "var(--text-primary)",
                    }}
                  >
                    <span className="text-[calc(11.5px*var(--font-scale))]">
                      {t("mcp.projectScope")}
                    </span>
                    {/* 未设置（跟随上层）不是「已开」：安全决定不得与事实不符 */}
                    {scopeUnset && (
                      <span
                        className="text-[calc(9.5px*var(--font-scale))]"
                        style={{ color: "var(--text-tertiary)" }}
                        data-testid="mcp-project-scope-unset"
                      >
                        {t("mcp.projectScopeUnset")}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={scopeOn}
                    disabled={projectScope.disabled || projectScope.pending}
                    data-testid="mcp-project-scope-switch"
                    data-on={scopeOn ? "true" : "false"}
                    data-unset={scopeUnset ? "true" : "false"}
                    onClick={(e) => {
                      e.stopPropagation();
                      projectScope.onToggle(!scopeOn);
                    }}
                    className="relative shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{
                      width: 38,
                      height: 22,
                      borderRadius: 9999,
                      background: scopeOn
                        ? "var(--brand)"
                        : "var(--hairline-strong)",
                      transition: "background 0.2s",
                    }}
                  >
                    <span
                      className="absolute top-0.5 rounded-full bg-white transition-all"
                      style={{
                        width: 18,
                        height: 18,
                        left: scopeOn ? undefined : 2,
                        right: scopeOn ? 2 : undefined,
                        boxShadow: "0 1px 2px rgba(0,0,0,.1)",
                      }}
                    />
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
