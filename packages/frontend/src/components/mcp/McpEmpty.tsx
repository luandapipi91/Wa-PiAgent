export function McpEmpty() {
  return (
    <div className="flex flex-col items-center justify-center py-16" data-testid="mcp-empty">
      <div
        className="flex items-center justify-center text-3xl mb-4"
        style={{
          width: 72, height: 72, borderRadius: 20,
          background: "linear-gradient(135deg, var(--surface-elevated), var(--surface-hover))",
          border: "1px solid var(--hairline)",
        }}
      >🔌</div>
      <h4 className="font-extrabold text-lg mb-1.5 text-primary">暂无 MCP 服务器</h4>
      <p className="text-[13px] text-tertiary text-center leading-relaxed">
        点击上方「+ 手动添加」按钮添加 MCP 服务器配置。<br />
        配置将写入当前作用域的 .mcp.json 文件。
      </p>
    </div>
  );
}
