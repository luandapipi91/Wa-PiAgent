import { useCallback, useRef } from "react";

interface Props {
  /** 拖拽方向：left=左侧栏（向右拖增宽，width=clientX）；right=右侧栏（向左拖增宽，width=innerWidth-clientX） */
  side: "left" | "right";
  /** 宽度变化回调（已 clamp 到 [minWidth, innerWidth*maxRatio]） */
  onResize: (width: number) => void;
  /** 最小宽度（px），默认 200 */
  minWidth?: number;
  /** 最大宽度占视口比例，默认 0.4（40%） */
  maxRatio?: number;
  /** 测试钩子 */
  testId?: string;
}

/**
 * 通用拖拽分隔条：mousedown 启动，window 级 mousemove/mouseup 驱动宽度变化。
 * 根据 side 决定宽度计算方向，clamp 到 [minWidth, innerWidth*maxRatio]。拖拽中禁用文本选中。
 * 视觉 2px 宽，含更宽的透明热区便于抓取。
 */
export function SidebarResizer({ side, onResize, minWidth = 200, maxRatio = 0.4, testId }: Props) {
  const dragging = useRef(false);

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging.current) return;
      const raw = side === "left" ? e.clientX : window.innerWidth - e.clientX;
      const clamped = Math.max(minWidth, Math.min(window.innerWidth * maxRatio, raw));
      onResize(clamped);
    },
    [side, onResize, minWidth, maxRatio],
  );

  const onMouseUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  }, [onMouseMove]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [onMouseMove, onMouseUp],
  );

  return (
    <div
      data-testid={testId}
      onMouseDown={onMouseDown}
      style={{
        width: 2,
        cursor: "col-resize",
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
