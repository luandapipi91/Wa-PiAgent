import { createRoot } from "react-dom/client";
import { Component } from "react";
import i18n from "./i18n";
import { App } from "./App";
import { Icon } from "./components/ui/Icon";
// import "./i18n" 触发模块顶层初始化：同步检测首次语言（localStorage 优先 →
// navigator → zh）、init i18next 实例、同步 <html lang>。
import "./i18n";
import { initialLanguage } from "./i18n";
import { useUiPrefsStore } from "./store/ui-prefs";
import "./styles.css";

// 兜底：React 未捕获异常时避免白屏，显示错误摘要供用户反馈。
// class 组件不能用 hook，但 ./i18n 已在模块加载时同步初始化 i18next 实例，
// 这里直接用实例的 t 取当前语言文案。
class ErrorBoundary extends Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          height: "100vh", fontFamily: 'MiSans, system-ui, "PingFang SC", sans-serif',
          color: "#1d1d1f", background: "#F5F5F7", padding: 48, textAlign: "center",
        }}>
          <div style={{ marginBottom: 16 }}><Icon name="warning" size={48} /></div>
          <h2 style={{ margin: "0 0 8px" }}>{i18n.t("common.appError")}</h2>
          <p style={{ color: "#86868b", maxWidth: 480, lineHeight: 1.6 }}>
            {this.state.error.message}
          </p>
          <button
            onClick={() => location.reload()}
            style={{
              marginTop: 24, padding: "10px 28px", borderRadius: 8, border: "none",
              background: "var(--brand)", color: "#fff", fontSize: "calc(15px * var(--font-scale))", cursor: "pointer",
            }}
          >{i18n.t("common.reload")}</button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary><App /></ErrorBoundary>
);

// i18n 已在 ./i18n 模块加载时同步初始化；这里把检测到的首次语言写回 ui-prefs
// store，让设置面板的「语言」选项与实际生效语言保持一致。
useUiPrefsStore.setState({ language: initialLanguage });
