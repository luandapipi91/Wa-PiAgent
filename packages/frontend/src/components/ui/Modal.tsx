import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { clampModalPos, readSavedPos, saveModalPos, type ModalPos } from "./modal-position";
import {
  MIN_MODAL_H,
  MIN_MODAL_W,
  clampModalSize,
  readSavedSize,
  saveModalSize,
  type ModalSize,
} from "./modal-size";

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
  // 卡片最大高度（如 "70vh"）：内容超出时被限制在该高度内，
  // 配合内容区 overflow-y-auto 实现限高滚动（防长内容溢出视口）
  maxHeight?: number | string;
  // 点击遮罩层是否关闭弹窗，默认 false：弹窗内可能正在输入/操作，点阴影误关会丢内容；
  // 需要点阴影关闭的弹窗（如简单确认框）显式传 true
  closeOnOverlayClick?: boolean;
  // 按 ESC 是否关闭弹窗，默认 true
  closeOnEsc?: boolean;
  // 是否允许拖动右下角手柄调整卡片大小（参考浮动预览窗 FloatWindow 的拖拽交互）
  resizable?: boolean;
  // 拖拽结束（mouseup）时一次性回调最终尺寸（px），用于调用方持久化
  onResize?: (size: { width: number; height: number }) => void;
  // 是否支持拖动窗口移动位置：按住卡片内 data-modal-drag-handle 标记的标题栏拖动；
  // 标题栏上的按钮/输入等交互元素不触发拖动（保持原行为）
  draggable?: boolean;
  // 拖动位置持久化键：传入后打开时读该键恢复上次位置，拖动结束写入；
  // 注意弹窗需“关闭→重新打开”时重新挂载（调用方无内容时返回 null），否则读不到新位置
  positionStorageKey?: string;
  // 拖动结束（mouseup）时一次性回调最终位置（视口坐标 px）
  onMove?: (pos: ModalPos) => void;
  // 尺寸持久化键（配合 resizable）：打开时读该键恢复上次尺寸（按当前视口夹过），
  // 拖手柄结束写入；缺省则尺寸由 width/height props 决定
  sizeStorageKey?: string;
  // 透传到卡片容器的 testid（区分不同弹窗实例）
  "data-testid"?: string;
}

/** 拖动把手标记：子组件在标题栏元素上加该属性，按住即可拖动整个弹窗 */
const DRAG_HANDLE_SELECTOR = "[data-modal-drag-handle]";
/** 交互元素：在其上按下不触发拖动（同 FloatWindow 口径） */
const INTERACTIVE_SELECTOR =
  'button, input, a, select, textarea, [contenteditable], [role="textbox"]';

// 拖动调整大小的最小边界：保证内容可读（上限不超视口）
const MIN_W = MIN_MODAL_W;
const MIN_H = MIN_MODAL_H;

export function Modal({
  children,
  onClose,
  width = 480,
  height,
  maxHeight,
  closeOnOverlayClick = false,
  closeOnEsc = true,
  resizable = false,
  onResize,
  draggable = false,
  positionStorageKey,
  onMove,
  sizeStorageKey,
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
  const move = useRef<{
    startX: number;
    startY: number;
    left: number;
    top: number;
    w: number;
    h: number;
    last: ModalPos;
  } | null>(null);
  const [moving, setMoving] = useState(false);
  // 尺寸（null = 用 width/height props）：挂载时从持久化键读一次，此后由拖手柄更新
  const [size, setSize] = useState<ModalSize | null>(() =>
    sizeStorageKey ? readSavedSize(sizeStorageKey) : null,
  );
  // 拖动后的位置（null = 居中）：挂载时从持久化键读一次，此后由拖动更新
  const [pos, setPos] = useState<ModalPos | null>(() =>
    positionStorageKey ? readSavedPos(positionStorageKey) : null,
  );
  const mountPos = useRef(pos);

  // 恢复的位置夹一次：上次记录可能因窗口变小而落到视口外（布局就绪后才能量到卡片尺寸）
  useLayoutEffect(() => {
    const el = cardRef.current;
    const p = mountPos.current;
    if (!el || !p) return;
    const rect = el.getBoundingClientRect();
    const clamped = clampModalPos(p.left, p.top, rect.width, rect.height);
    if (clamped.left !== p.left || clamped.top !== p.top) setPos(clamped);
  }, []);

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
    setSize(d.last);
    if (sizeStorageKey) saveModalSize(sizeStorageKey, d.last);
    onResize?.(d.last);
  }, [onMouseMove, onResize, sizeStorageKey]);

  // 拖动位置：与拖尺寸同款（拖中直接改 DOM 跟手，mouseup 一次性提交回调）
  const onMoveMove = useCallback((e: MouseEvent) => {
    const d = move.current;
    const el = cardRef.current;
    if (!d || !el) return;
    const next = clampModalPos(
      d.left + e.clientX - d.startX,
      d.top + e.clientY - d.startY,
      d.w,
      d.h,
    );
    d.last = next;
    el.style.left = next.left + "px";
    el.style.top = next.top + "px";
  }, []);

  const onMoveUp = useCallback(() => {
    const d = move.current;
    if (!d) return;
    move.current = null;
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onMoveMove);
    window.removeEventListener("mouseup", onMoveUp);
    setMoving(false);
    setPos(d.last);
    if (positionStorageKey) saveModalPos(positionStorageKey, d.last);
    onMove?.(d.last);
  }, [onMoveMove, onMove, positionStorageKey]);

  const startMove = useCallback(
    (e: React.MouseEvent) => {
      const el = cardRef.current;
      if (!el) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // 脱离 flex 居中并钉住当前位置，之后拖动只改 left/top
      el.style.position = "fixed";
      el.style.left = rect.left + "px";
      el.style.top = rect.top + "px";
      el.style.margin = "0";
      move.current = {
        startX: e.clientX,
        startY: e.clientY,
        left: rect.left,
        top: rect.top,
        w: rect.width,
        h: rect.height,
        last: { left: rect.left, top: rect.top },
      };
      document.body.style.userSelect = "none";
      setMoving(true);
      window.addEventListener("mousemove", onMoveMove);
      window.addEventListener("mouseup", onMoveUp);
    },
    [onMoveMove, onMoveUp],
  );

  // 只有标题栏空白处按下才拖窗：内容区、标题栏上的按钮/输入等保持原行为
  const onCardMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!draggable) return;
      const target = e.target as HTMLElement;
      if (!target.closest(DRAG_HANDLE_SELECTOR)) return;
      if (target.closest(INTERACTIVE_SELECTOR)) return;
      startMove(e);
    },
    [draggable, startMove],
  );

  // 弹窗在拖拽中卸载（如 ESC 关闭）时清理 window 监听，防泄漏
  useEffect(() => {
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("mousemove", onMoveMove);
      window.removeEventListener("mouseup", onMoveUp);
    };
  }, [onMouseMove, onMouseUp, onMoveMove, onMoveUp]);

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
          width: size?.width ?? width,
          height: size?.height ?? height,
          maxHeight,
          boxShadow: "var(--shadow-lg)",
          // 无位置记录：relative 居中（并锚定右下角缩放手柄）；有记录：fixed 钉在记录坐标
          ...(pos
            ? { position: "fixed", left: pos.left, top: pos.top, margin: 0 }
            : { position: "relative" }),
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={onCardMouseDown}
        data-testid={rest["data-testid"] ?? "modal-content"}
        ref={cardRef}
      >
        {/* 拖拽中屏蔽内容区指针事件：防内容（图片拖选/文本选择）干扰 mousemove/mouseup */}
        <div
          className="flex-1 overflow-hidden flex flex-col"
          style={resizing || moving ? { pointerEvents: "none" } : undefined}
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
