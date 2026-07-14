import { useEffect, useState, type CSSProperties } from "react";
import { useMcpStore } from "../../store/mcp";
import { useProjectsStore } from "../../store/projects";
import { McpCard } from "./McpCard";
import { McpEmpty } from "./McpEmpty";
import { McpForm } from "./McpForm";
import { McpToolsModal } from "./McpToolsModal";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { McpServerConfig } from "@hiagent/shared";

export function McpPage() {
  const {
    servers, serverStatuses, toolsCache,
    selectedProjectId, searchQuery, loading,
    load, save, deleteServer, testConnection, listTools, clearAuth,
    setSelectedProjectId, setSearchQuery,
  } = useMcpStore();

  const currentProjectId = useProjectsStore(s => s.currentProjectId);
  const projects = useProjectsStore(s => s.projects);

  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerConfig | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showToolsFor, setShowToolsFor] = useState<string | null>(null);

  // 首次进入：若 store 未选项目且当前有打开项目，初始化为该项目
  const activeProjectId = selectedProjectId ?? currentProjectId;
  useEffect(() => {
    if (selectedProjectId === null && currentProjectId) {
      setSelectedProjectId(currentProjectId);
    }
  }, [selectedProjectId, currentProjectId, setSelectedProjectId]);

  // 加载列表
  useEffect(() => {
    load(activeProjectId ?? undefined);
  }, [activeProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 搜索过滤
  const filtered = servers.filter(s =>
    !searchQuery || s.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleFormSave = (config: McpServerConfig, originalName?: string) => {
    save(config, activeProjectId ?? undefined, originalName);
    setShowForm(false);
    setEditingServer(null);
  };

  const handleTest = (serverName: string) => {
    testConnection(serverName, activeProjectId ?? undefined);
  };

  const handleViewTools = (serverName: string) => {
    // 先发起 WS 请求取最新工具列表
    listTools(serverName);
    setShowToolsFor(serverName);
  };

  const handleClearAuth = (serverName: string) => {
    clearAuth(serverName, activeProjectId ?? undefined);
    // 重置状态为 disconnected
    useMcpStore.setState(s => ({
      serverStatuses: { ...s.serverStatuses, [serverName]: "disconnected" },
    }));
  };

  const handleDelete = (serverName: string) => {
    deleteServer(serverName, activeProjectId ?? undefined);
    setConfirmDelete(null);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="mcp-page">
      {/* 标题栏 */}
      <div
        className="flex items-center px-5 py-3.5"
        style={{ background: "var(--surface)", borderBottom: "1px solid var(--hairline)" }}
      >
        <h2 className="text-base font-extrabold text-primary m-0">🔌 MCP 连接器</h2>
      </div>

      {/* 工具栏 */}
      <div className="flex items-center gap-2.5 px-5 py-2.5" style={{ background: "var(--surface)", borderBottom: "1px solid var(--hairline)" }}>
        {/* 作用域下拉 */}
        <ScopeDropdown
          selectedProjectId={activeProjectId ?? null}
          projects={projects}
          onSelect={(projectId) => setSelectedProjectId(projectId)}
        />

        {/* 搜索 */}
        <input
          className="flex-1 text-[12px] px-3 py-1.5 rounded-lg min-w-0"
          style={{ background: "var(--canvas)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
          placeholder="🔍 搜索服务器..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          data-testid="mcp-search"
        />

        {/* 添加按钮 */}
        <button
          onClick={() => { setShowForm(v => !v); setEditingServer(null); }}
          className="text-[11px] font-semibold px-3 py-1.5 rounded-md text-white shrink-0"
          style={{ background: showForm ? "var(--text-tertiary)" : "var(--accent)", border: "none" }}
          data-testid="mcp-add-button"
        >{showForm ? "取消" : "+ 手动添加"}</button>
      </div>

      {/* 添加/编辑表单 */}
      {(showForm || editingServer) && (
        <div className="px-5 py-3" style={{ background: "var(--surface)", borderBottom: "1px solid var(--hairline)" }}>
          <McpForm
            initial={editingServer ?? undefined}
            onSave={handleFormSave}
            onCancel={() => { setShowForm(false); setEditingServer(null); }}
          />
        </div>
      )}

      {/* 列表内容 */}
      <div className="flex-1 overflow-y-auto px-5 py-3.5">
        {loading ? (
          <div className="text-center text-tertiary text-[12.5px] py-8">加载中...</div>
        ) : filtered.length === 0 ? (
          <McpEmpty />
        ) : (
          filtered.map(s => (
            <McpCard
              key={s.name}
              config={s}
              status={serverStatuses[s.name] ?? "disconnected"}
              onTest={() => handleTest(s.name)}
              onViewTools={() => handleViewTools(s.name)}
              onAuth={() => handleTest(s.name)}
              onClearAuth={() => handleClearAuth(s.name)}
              onEdit={() => { setEditingServer(s); setShowForm(false); }}
              onDelete={() => setConfirmDelete(s.name)}
            />
          ))
        )}
      </div>

      {/* 工具列表 Modal */}
      {showToolsFor && (
        <McpToolsModal
          serverName={showToolsFor}
          tools={toolsCache[showToolsFor] ?? []}
          onClose={() => setShowToolsFor(null)}
        />
      )}

      {/* 删除确认弹窗 */}
      {confirmDelete && (
        <ConfirmDialog
          title="确认删除"
          message={`确定要删除 MCP 服务器 ${confirmDelete} 吗？`}
          confirmText="删除"
          danger
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

// —— 作用域下拉（复用 MemoryPage 的 MemoryScopeDropdown 模式）——

function ScopeDropdown({ selectedProjectId, projects, onSelect }: {
  selectedProjectId: string | null;
  projects: { id: string; name: string }[];
  onSelect: (projectId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const isGlobal = selectedProjectId === null;
  const label = isGlobal
    ? "🌐 全局"
    : (projects.find(p => p.id === selectedProjectId)?.name ?? "项目");

  const itemStyle = (active: boolean): CSSProperties => ({
    color: active ? "var(--accent)" : "var(--text-primary)",
    background: active ? "var(--accent-soft)" : "transparent",
  });

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 text-[11.5px] px-2.5 py-1.5 rounded-md"
        style={{ background: "var(--surface)", border: "1px solid var(--hairline)", color: "var(--text-primary)" }}
        data-testid="mcp-scope-select"
      >
        {label}
        <span className="text-[9px] opacity-70">▾</span>
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
            style={{ background: "var(--surface)", border: "1px solid var(--hairline)" }}
            data-testid="mcp-scope-menu"
          >
            <button
              type="button"
              onClick={() => { onSelect(null); setOpen(false); }}
              className="block w-full text-left text-[11.5px] px-3 py-1.5"
              style={itemStyle(isGlobal)}
              data-testid="mcp-scope-option-global"
            >🌐 全局</button>
            {projects.length > 0 && (
              <div className="my-1" style={{ borderTop: "1px solid var(--hairline)" }} />
            )}
            {projects.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => { onSelect(p.id); setOpen(false); }}
                className="block w-full text-left text-[11.5px] px-3 py-1.5 truncate"
                style={itemStyle(selectedProjectId === p.id)}
                data-testid={`mcp-scope-option-project-${p.id}`}
                title={p.name}
              >📁 {p.name}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
