import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

// 通用弹窗容器：fixed 全屏遮罩 + 居中卡片
// 沿用 AgentConfig 的写法（fixed inset-0 z-50 + rgba 遮罩），补齐点击遮罩/ESC 关闭。
// 用 createPortal 渲染到 document.body：脱离挂载点（可能有 transform/overflow 祖先）的
// 布局与层叠上下文，保证遮罩真正全屏覆盖、点击阴影可靠触发 onClose。
interface ModalProps {
  children: ReactNode;
  onClose: () => void;
  // 卡片宽度，默认 480px（适合确认框）；AgentConfig 等大弹窗可传 800 或 "80vw"
  width?: number | string;
  // 卡片高度，默认由内容撑开；可传 "80vh" 等固定高度
  height?: number | string;
  // 点击遮罩层是否关闭弹窗，默认 false：弹窗内可能正在输入/操作，点阴影误关会丢内容；
  // 需要点阴影关闭的弹窗（如简单确认框）显式传 true
  closeOnOverlayClick?: boolean;
  // 按 ESC 是否关闭弹窗，默认 true
  closeOnEsc?: boolean;
  // 透传到卡片容器的 testid（区分不同弹窗实例）
  "data-testid"?: string;
}

export function Modal({
  children,
  onClose,
  width = 480,
  height,
  closeOnOverlayClick = false,
  closeOnEsc = true,
  ...rest
}: ModalProps) {
  // ESC 关闭
  useEffect(() => {
    if (!closeOnEsc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, closeOnEsc]);

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "rgba(0,0,0,0.25)" }}
      onClick={closeOnOverlayClick ? onClose : undefined}
      data-testid="modal-overlay"
    >
      <div
        className="rounded-lg flex flex-col border border-hairline"
        style={{
          background: "var(--surface)",
          width,
          height,
          boxShadow: "var(--shadow-lg)",
        }}
        onClick={(e) => e.stopPropagation()}
        data-testid={rest["data-testid"] ?? "modal-content"}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
