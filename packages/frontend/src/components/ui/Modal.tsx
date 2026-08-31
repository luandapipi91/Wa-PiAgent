import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  // 是否允许拖动右下角手柄调整卡片大小（参考浮动预览窗 FloatWindow 的拖拽交互）
  resizable?: boolean;
  // 拖拽结束（mouseup）时一次性回调最终尺寸（px），用于调用方持久化
  onResize?: (size: { width: number; height: number }) => void;
  // 透传到卡片容器的 testid（区分不同弹窗实例）
  "data-testid"?: string;
}

// 拖拽调整大小的最小/边界约束：最小 320×240 保证内容可读，最大不超过视口
const MIN_W = 320;
const MIN_H = 240;

export function Modal({
  children,
  onClose,
  width = 480,
  height,
  closeOnOverlayClick = false,
  closeOnEsc = true,
  resizable = false,
  onResize,
  ...rest
}: ModalProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    startX: number;
    startY: number;
    baseW: number;
    baseH: number;
    left: number;
    top: number;
    last: { width: number; height: number };
  } | null>(null);
  const [resizing, setResizing] = useState(false);

  // ESC 关闭
  useEffect(() => {
    if (!closeOnEsc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, closeOnEsc]);

  // 拖拽中直接改 DOM style（不经 React 渲染，跟手），mouseup 才一次性回调最终尺寸
  // —— 与 FloatWindow 同款模式
  const onMouseMove = useCallback((e: MouseEvent) => {
    const d = drag.current;
    const el = cardRef.current;
    if (!d || !el) return;
    // 上限 = 视口 − 锚定的左上角偏移（拖大不溢出视口右/下缘）
    const w = Math.min(
      window.innerWidth - d.left,
      Math.max(MIN_W, d.baseW + e.clientX - d.startX),
    );
    const h = Math.min(
      window.innerHeight - d.top,
      Math.max(MIN_H, d.baseH + e.clientY - d.startY),
    );
    d.last = { width: w, height: h };
    el.style.width = w + "px";
    el.style.height = h + "px";
  }, []);

  const onMouseUp = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    setResizing(false);
    onResize?.(d.last);
  }, [onMouseMove, onResize]);

  // 弹窗在拖拽中卸载（如 ESC 关闭）时清理 window 监听，防泄漏
  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      const el = cardRef.current;
      if (!el) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // 锚定左上角：转 fixed 定位钉住当前位置，拖动手柄只改宽高（右下角跟手，
      // 不因 flex 居中导致左上角反向漂移）；关闭重开后随重挂载恢复居中
      el.style.position = "fixed";
      el.style.left = rect.left + "px";
      el.style.top = rect.top + "px";
      el.style.margin = "0";
      drag.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseW: rect.width,
        baseH: rect.height,
        left: rect.left,
        top: rect.top,
        last: { width: rect.width, height: rect.height },
      };
      document.body.style.userSelect = "none";
      setResizing(true);
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [onMouseMove, onMouseUp],
  );

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
          // relative：锚定右下角缩放手柄
          position: "relative",
        }}
        onClick={(e) => e.stopPropagation()}
        data-testid={rest["data-testid"] ?? "modal-content"}
        ref={cardRef}
      >
        {/* 拖拽中屏蔽内容区指针事件：防内容（图片拖选/文本选择）干扰 mousemove/mouseup */}
        <div
          className="flex-1 overflow-hidden flex flex-col"
          style={resizing ? { pointerEvents: "none" } : undefined}
        >
          {children}
        </div>
        {resizable && (
          <div
            data-testid="modal-resize-handle"
            onMouseDown={startResize}
            style={{
              position: "absolute",
              right: 0,
              bottom: 0,
              width: 14,
              height: 14,
              cursor: "nwse-resize",
              background:
                "linear-gradient(135deg, transparent 50%, var(--hairline-strong, #666) 50%)",
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
