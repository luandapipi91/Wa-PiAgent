// ===== 可选插件（扩展）管理类型定义 =====

/** 可选插件信息（驱动 UI 展示与启用态） */
export interface ExtensionPluginInfo {
  id: string;            // 稳定标识（前端用）
  displayName: string;
  description: string;
  enabled: boolean;
  version?: string;
}

// ===== WS 协议事件（插件管理）=====

// 前端 → kernel
export interface ExtensionListEvent { type: "extension:list"; }
export interface ExtensionToggleEvent {
  type: "extension:toggle";
  id: string;
  enabled: boolean;      // true=启用，false=禁用
}

// kernel → 前端（extension:list 和 extension:changed 结构相同）
export interface ExtensionListResult {
  type: "extension:list";
  plugins: ExtensionPluginInfo[];
}

export interface ExtensionChangedEvent {
  type: "extension:changed";
  plugins: ExtensionPluginInfo[];
}
