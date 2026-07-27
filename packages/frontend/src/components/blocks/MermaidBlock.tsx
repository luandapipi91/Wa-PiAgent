import { useEffect, useRef, useState, useCallback } from "react";
import mermaid from "mermaid";
import { Modal } from "../ui/Modal";
import { useToastStore } from "../../store/toast";

// 缩放配置
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const SCALE_STEP = 0.25;

let initialized = false;
function ensureInit() {
  if (initialized) return;
  initialized = true;
  mermaid.initialize({
    startOnLoad: false,
    theme: "default",
    securityLevel: "strict",
    suppressErrorRendering: true,
  });
}

interface Props {
  code: string;
}

/** SVG 字符串转为 PNG Blob（DOM 内渲染，处理 foreignObject，2x 分辨率） */
async function svgToPngBlob(svgText: string): Promise<Blob> {
  // 预处理：将 foreignObject 替换为 text（<img> 中 foreignObject 不渲染）
  const processed = svgText.replace(
    /<foreignObject[^>]*>[\s\S]*?<\/foreignObject>/g,
    (match) => {
      const divMatch = match.match(/<div[^>]*>([\s\S]*?)<\/div>/);
      const text = divMatch?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
      if (!text) return "";
      // 提取 foreignObject 的 x/y/width/height
      const x = match.match(/x="([^"]+)"/)?.[1] ?? "0";
      const y = match.match(/y="([^"]+)"/)?.[1] ?? "0";
      return `<text x="${x}" y="${y}" class="label">${text}</text>`;
    },
  );

  // 将 SVG 渲染到 DOM（确保样式计算完整）
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;";
  container.innerHTML = processed;
  document.body.appendChild(container);

  const svgEl = container.querySelector("svg")!;
  if (!svgEl) {
    document.body.removeChild(container);
    throw new Error("无效的 SVG");
  }

  // 用 getBBox 或 viewBox 获取真实尺寸
  const vb = svgEl.getAttribute("viewBox")?.split(/\s+/).map(Number);
  let w = vb?.[2] ?? 800;
  let h = vb?.[3] ?? 600;

  // 如果 viewBox 尺寸不合理，用 getBoundingClientRect
  if (!w || !h || w <= 0 || h <= 0) {
    const rect = svgEl.getBoundingClientRect();
    w = rect.width || 800;
    h = rect.height || 600;
  }

  // 序列化（此时 DOM 已渲染完整）
  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(svgEl);
  document.body.removeChild(container);

  // Canvas 渲染（2x 高清）
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);

  // Blob URL 避免 base64 编码问题
  const svgBlob = new Blob([svgString], { type: "image/svg+xml" });
  const url = URL.createObjectURL(svgBlob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      // 白底填充
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolve(pngBlob);
        else reject(new Error("Canvas toBlob 失败"));
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG 加载失败"));
    };
    img.src = url;
  });
}

/** 用 mermaid 渲染图表为 SVG 展示，无效语法显示错误。支持放大弹窗 + 拖拽 + 缩放 + 复制 */
export function MermaidBlock({ code }: Props) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const addToast = useToastStore((s) => s.add);

  useEffect(() => {
    ensureInit();

    const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
    const container = document.createElement("div");
    container.id = id;
    container.style.display = "none";
    document.body.appendChild(container);
    containerRef.current = container;

    mermaid
      .render(id, code)
      .then((result) => {
        setSvg(result.svg);
        setError(null);
      })
      .catch((err: any) => {
        setError(err?.message ?? String(err));
        setSvg(null);
      });

    return () => {
      if (containerRef.current) {
        containerRef.current.remove();
        containerRef.current = null;
      }
    };
  }, [code]);

  // --- 拖拽平移 ---
  const [dragging, setDragging] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragStart = useRef({ x: 0, y: 0 });

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      setDragging(true);
      dragStart.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
    },
    [offset],
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      setOffset({
        x: e.clientX - dragStart.current.x,
        y: e.clientY - dragStart.current.y,
      });
    },
    [dragging],
  );

  const onMouseUp = useCallback(() => setDragging(false), []);

  // --- 缩放 ---
  const [scale, setScale] = useState(1);

  const zoomIn = useCallback(() => {
    setScale((s) => Math.min(MAX_SCALE, +(s + SCALE_STEP).toFixed(2)));
  }, []);

  const zoomOut = useCallback(() => {
    setScale((s) => Math.max(MIN_SCALE, +(s - SCALE_STEP).toFixed(2)));
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      setScale((s) => Math.min(MAX_SCALE, +(s + SCALE_STEP).toFixed(2)));
    } else {
      setScale((s) => Math.max(MIN_SCALE, +(s - SCALE_STEP).toFixed(2)));
    }
  }, []);

  // 打开弹窗时重置
  const openModal = useCallback(() => {
    setOffset({ x: 0, y: 0 });
    setScale(1);
    setModalOpen(true);
  }, []);

  // --- 复制 ---
  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      addToast("Mermaid 代码已复制", "success");
    } catch {
      addToast("复制失败", "error");
    }
  }, [code, addToast]);

  const copyImage = useCallback(async () => {
    if (!svg) return;
    try {
      const pngBlob = await svgToPngBlob(svg);
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": pngBlob }),
      ]);
      addToast("图表已复制（PNG）", "success");
    } catch {
      addToast("复制失败", "error");
    }
  }, [svg, addToast]);

  // --- 渲染 ---

  if (error) {
    return (
      <div
        data-testid="mermaid-error"
        className="rounded-lg border border-hairline p-3 text-[12px] text-danger bg-surface my-1"
      >
        Mermaid 渲染失败：{error}
      </div>
    );
  }

  if (!svg) {
    return (
      <div
        data-testid="mermaid-loading"
        className="rounded-lg border border-hairline p-3 text-[12px] text-tertiary bg-surface my-1 text-center"
      >
        图表渲染中…
      </div>
    );
  }

  return (
    <>
      {/* 缩略视图 — SVG 自然撑满容器宽度 */}
      <div className="rounded-lg border border-hairline overflow-x-auto p-3 bg-white my-1 relative group">
        <div className="w-full" data-testid="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
        <button
          type="button"
          data-testid="mermaid-zoom-btn"
          onClick={openModal}
          className="absolute right-1.5 top-1.5 w-6 h-6 rounded-md bg-surface-elevated border border-hairline flex items-center justify-center text-tertiary hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
          title="放大查看"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="11" y1="8" x2="11" y2="14" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </button>
      </div>

      {/* 放大弹窗 */}
      {modalOpen && (
        <Modal
          width="85vw"
          height="85vh"
          onClose={() => setModalOpen(false)}
          data-testid="mermaid-modal"
        >
          {/* 头部栏 */}
          <div className="flex items-center px-4 py-2.5 border-b border-hairline shrink-0 gap-2">
            <span className="text-[13px] font-semibold text-primary">图表预览</span>

            {/* 缩放 */}
            <span
              data-testid="mermaid-scale-label"
              className="text-[12px] text-tertiary tabular-nums min-w-[3em] text-center"
            >
              {Math.round(scale * 100)}%
            </span>

            <button
              type="button"
              data-testid="mermaid-zoom-out"
              onClick={zoomOut}
              disabled={scale <= MIN_SCALE}
              className="w-6 h-6 rounded-md border border-hairline flex items-center justify-center text-tertiary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="缩小"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" /></svg>
            </button>
            <button
              type="button"
              data-testid="mermaid-zoom-in"
              onClick={zoomIn}
              disabled={scale >= MAX_SCALE}
              className="w-6 h-6 rounded-md border border-hairline flex items-center justify-center text-tertiary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="放大"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" /></svg>
            </button>

            {/* 分隔 */}
            <span className="w-px h-4 bg-hairline mx-1" />

            {/* 复制代码 */}
            <button
              type="button"
              data-testid="mermaid-copy-code"
              onClick={copyCode}
              className="w-6 h-6 rounded-md border border-hairline flex items-center justify-center text-tertiary hover:text-primary transition-colors"
              title="复制 Mermaid 代码"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" ry="1" /></svg>
            </button>

            {/* 复制图片 */}
            <button
              type="button"
              data-testid="mermaid-copy-image"
              onClick={copyImage}
              className="w-6 h-6 rounded-md border border-hairline flex items-center justify-center text-tertiary hover:text-primary transition-colors"
              title="复制图表图片"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            </button>

            {/* 关闭 */}
            <button
              type="button"
              data-testid="mermaid-modal-close"
              onClick={() => setModalOpen(false)}
              className="ml-auto w-7 h-7 rounded-md flex items-center justify-center text-tertiary hover:text-primary hover:bg-surface-hover transition-colors"
              title="关闭"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>

          {/* 可滚动 + 可拖拽 + 可缩放 */}
          <div
            data-testid="mermaid-modal-viewport"
            className="flex-1 min-h-0 overflow-auto bg-[#f8f8f8]"
            onWheel={onWheel}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          >
            <div
              data-testid="mermaid-modal-inner"
              className="inline-block min-w-full min-h-full p-8 select-none"
              style={{
                cursor: dragging ? "grabbing" : "grab",
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                transformOrigin: "0 0",
              }}
              onMouseDown={onMouseDown}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </Modal>
      )}
    </>
  );
}
