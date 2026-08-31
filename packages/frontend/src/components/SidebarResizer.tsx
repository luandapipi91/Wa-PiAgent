import { useCallback, useRef } from "react";

interface Props {
  /** 拖拽方向：left=左侧面板（向右拖增宽）；right=右侧面板（向左拖增宽） */
  side: "left" | "right";
  /** 取当前宽度（px），mousedown 时快照一次作为增量基准（不从 store 订阅，避免拖拽期重渲染） */
  getWidth: () => number;
  /** 宽度变化回调（已 clamp 到 [minWidth, innerWidth*maxRatio]） */
  onResize: (width: number) => void;
  /** 最小宽度（px），默认 200 */
  minWidth?: number;
  /** 最大宽度占视口比例，默认 0.4（40%） */
  maxRatio?: number;
  /** 绝对最大宽度（px）：优先于 maxRatio 生效。用于“需要为固定区域预留空间”的场景
   * （如地址栏右侧的图标按钮区）。取函数而非数值：布局宽度只有在拖拽时读才新鲜
   * （面板初次挂载/窗口变化后的旧 prop 会把过期上限固化进 JSX） */
  getMaxPx?: () => number;
  /** 测试钩子 */
  testId?: string;
  /** 视觉形态：panel=面板边缘发丝细线（默认）；
   *  inline=工具栏内嵌小把手（热区更宽、可见圆角条 + hover 品牌色高亮） */
  variant?: "panel" | "inline";
  /** 悬浮提示文案（随形态透传到 title） */
  title?: string;
}

/**
 * 通用拖拽分隔条：mousedown 启动，window 级 mousemove/mouseup 驱动宽度变化。
 * 增量计算（mousedown 时的起始宽度 + 位移增量），与面板在视口中的绝对位置无关——
 * 分屏等多栏布局下右侧面板右缘不在视口右缘时也能正常拖拽。
 * clamp 到 [minWidth, innerWidth*maxRatio]。拖拽中禁用文本选中。
 * 拖拽期间屏蔽所有 iframe 的指针事件：防止鼠标划过 iframe（如浏览器预览）
 * 时 mousemove/mouseup 被吞导致拖拽卡死、监听器泄漏。
 * 视觉 2px 宽，含更宽的透明热区便于抓取。
 */
export function SidebarResizer({
  side,
  getWidth,
  onResize,
  minWidth = 200,
  maxRatio = 0.4,
  getMaxPx,
  testId,
  variant = "panel",
  title,
}: Props) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  /** 拖拽期间屏蔽/恢复所有 iframe 指针事件（防 iframe 吞 mousemove/mouseup） */
  const shieldIframes = useCallback((on: boolean) => {
    for (const f of document.querySelectorAll("iframe")) {
      f.style.pointerEvents = on ? "none" : "";
    }
  }, []);

  /** 拖拽中变更回调时保留最新引用，避免旧闭包继续被调用 */
  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const delta =
        side === "left" ? e.clientX - d.startX : d.startX - e.clientX;
      const clamped = Math.max(
        minWidth,
        Math.min(
          getMaxPx?.() ?? Infinity,
          window.innerWidth * maxRatio,
          d.startWidth + delta,
        ),
      );
      onResize(clamped);
    },
    [side, onResize, minWidth, maxRatio, getMaxPx],
  );

  const onMouseUp = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    shieldIframes(false);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  }, [onMouseMove, shieldIframes]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      // 冒泡隔离：把手按下即归把手所有。宿主容器可能有「拖拽移动」类处理器
      // （如浮动预览窗整窗拖动），不阻断会让拖宽度同时带动窗口平移
      e.stopPropagation();
      drag.current = { startX: e.clientX, startWidth: getWidth() };
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ew-resize";
      shieldIframes(true);
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [getWidth, onMouseMove, onMouseUp, shieldIframes],
  );

  if (variant === "inline") {
    // 内嵌小把手：10px 热区内居中一条 4×20 圆角竖条，
    // hairline-strong 常态可见、hover/拖拽感知用品牌色高亮提示「这里能拖」
    return (
      <div
        data-testid={testId}
        data-variant="inline"
        title={title}
        onMouseDown={onMouseDown}
        className="group flex shrink-0 cursor-ew-resize items-center justify-center self-stretch"
        style={{ width: 10 }}
      >
        <div className="h-5 w-1 rounded-full bg-[var(--hairline-strong)] transition-colors group-hover:bg-[var(--brand)]" />
      </div>
    );
  }

  return (
    <div
      data-testid={testId}
      onMouseDown={onMouseDown}
      style={{
        width: 2,
        // mac 下 col-resize 字形是带竖线的特殊图形而非箭头；ew-resize 才是标准 ↔ 双向箭头
        cursor: "ew-resize",
        flexShrink: 0,
        background: "var(--hairline)",
        position: "relative",
      }}
    >
      {/* 透明热区：视觉 2px，但抓取区域更宽（左右各扩 4px）便于操作 */}
      <div style={{ position: "absolute", inset: "0 -4px" }} />
    </div>
  );
}
