import { createRoot } from "react-dom/client";
import { Component } from "react";
import { App } from "./App";
import "./styles.css";

// 兜底：React 未捕获异常时避免白屏，显示错误摘要供用户反馈
class ErrorBoundary extends Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          height: "100vh", fontFamily: 'system-ui, "PingFang SC", sans-serif',
          color: "#1d1d1f", background: "#F5F5F7", padding: 48, textAlign: "center",
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ margin: "0 0 8px" }}>应用发生错误</h2>
          <p style={{ color: "#86868b", maxWidth: 480, lineHeight: 1.6 }}>
            {this.state.error.message}
          </p>
          <button
            onClick={() => location.reload()}
            style={{
              marginTop: 24, padding: "10px 28px", borderRadius: 8, border: "none",
              background: "#4BA26F", color: "#fff", fontSize: 15, cursor: "pointer",
            }}
          >重新加载</button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary><App /></ErrorBoundary>
);
