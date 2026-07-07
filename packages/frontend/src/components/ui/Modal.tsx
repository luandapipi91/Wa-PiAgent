import { useEffect, type ReactNode } from "react";

// 通用弹窗容器：fixed 全屏遮罩 + 居中卡片
// 沿用 AgentConfig 的写法（fixed inset-0 z-50 + rgba 遮罩），补齐点击遮罩/ESC 关闭
interface ModalProps {
  children: ReactNode;
  onClose: () => void;
  // 卡片宽度，默认 480px（适合确认框）；AgentConfig 等大弹窗可传 800
  width?: number;
  // 透传到卡片容器的 testid（区分不同弹窗实例）
  "data-testid"?: string;
}

export function Modal({ children, onClose, width = 480, ...rest }: ModalProps) {
  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}  // 点击遮罩关闭
      data-testid="modal-overlay"
    >
      <div
        className="rounded-lg flex flex-col"
        style={{ background: "#1e1e2e", width }}
        onClick={e => e.stopPropagation()}  // 点击卡片不关闭
        data-testid={rest["data-testid"] ?? "modal-content"}
      >
        {children}
      </div>
    </div>
  );
}
