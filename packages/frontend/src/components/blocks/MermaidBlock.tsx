import { useEffect, useRef, useState, useCallback } from "react";
import mermaid from "mermaid";
import { Modal } from "../ui/Modal";
import { useToastStore } from "../../store/toast";
import { useTranslation } from "../../i18n/useTranslation";
import { copyToClipboard, copyImageToClipboard } from "../../util/clipboard";

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const SCALE_STEP = 0.25;
// 错误显示 debounce：流式过程中 code 频繁变化且不完整，解析必然失败；
// 仅当 code 稳定该时长后仍失败才显示错误，避免流式过程闪现"渲染失败"
const ERROR_DEBOUNCE_MS = 400;
// 成功渲染节流：流式中 code 每个 token 都变，但稳定的图不应重画。
// code 连续该时长不再变化后才执行 mermaid.render，token 间隔通常远小于此值，
// 故 timer 不断重置、render 不触发，图保持稳定；停顿/回合结束后才渲染最新版本。
const RENDER_DEBOUNCE_MS = 1000;

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

/** 将 foreignObject 转为等价的 text + tspan 元素（保留对齐和换行） */
function foreignObjectToText(foMatch: string): string {
  const x = foMatch.match(/\bx="([^"]*)"/)?.[1] ?? "0";
  const y = foMatch.match(/\by="([^"]*)"/)?.[1] ?? "0";
  const w = foMatch.match(/\bwidth="([^"]*)"/)?.[1];
  const h = foMatch.match(/\bheight="([^"]*)"/)?.[1];

  // 解析 div 样式判断对齐
  let textAnchor = "middle";
  const divStyle = foMatch.match(/<div[^>]*style="([^"]*)"[^>]*>/)?.[1] ?? "";
  if (/text-align:\s*left/.test(divStyle)) textAnchor = "start";
  else if (/text-align:\s*right/.test(divStyle)) textAnchor = "end";

  // 提取文本，<br/> 作为换行标记
  const divContent = foMatch.match(/<div[^>]*>([\s\S]*?)<\/div>/)?.[1];
  if (!divContent) return "";

  const lines = divContent
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return "";

  // 多行垂直居中
  const hNum = parseFloat(h ?? "0");
  const lineHeight = 16;
  const totalHeight = lines.length * lineHeight;
  const yStart =
    parseFloat(y) +
    (hNum > 0 ? (hNum - totalHeight) / 2 + lineHeight : lineHeight);

  const cx = (parseFloat(x) + parseFloat(w ?? "0") / 2).toFixed(1);
  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="${cx}" dy="${i === 0 ? yStart : lineHeight}">${line}</tspan>`,
    )
    .join("");

  return `<text text-anchor="${textAnchor}" font-family="sans-serif" font-size="14px">${tspans}</text>`;
}

/** SVG → PNG Blob（foreignObject→text 预处理 + DOM 渲染 + 2x） */
async function svgToPngBlob(svgText: string): Promise<Blob> {
  const processed = svgText.replace(
    /<foreignObject[^>]*>[\s\S]*?<\/foreignObject>/g,
    foreignObjectToText,
  );

  // 渲染到 DOM 确保样式计算完整
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;";
  container.innerHTML = processed;
  document.body.appendChild(container);

  const svgEl = container.querySelector("svg");
  if (!svgEl) {
    document.body.removeChild(container);
    throw new Error("Invalid SVG");
  }

  const vb = svgEl.getAttribute("viewBox")?.split(/\s+/).map(Number);
  let w = vb?.[2] ?? 800;
  let h = vb?.[3] ?? 600;
  if (!w || !h || w <= 0 || h <= 0) {
    const rect = svgEl.getBoundingClientRect();
    w = rect.width || 800;
    h = rect.height || 600;
  }

  const svgString = new XMLSerializer().serializeToString(svgEl);
  document.body.removeChild(container);

  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);

  const svgBlob = new Blob([svgString], { type: "image/svg+xml" });
  const url = URL.createObjectURL(svgBlob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((png) => {
        if (png) resolve(png);
        else reject(new Error("Canvas toBlob failed"));
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG load failed"));
    };
    img.src = url;
  });
}

interface Props {
  code: string;
}

export function MermaidBlock({ code }: Props) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 缓存上次成功渲染的 SVG 字符串，用于 diff：内容相同则不替换 DOM
  const lastSvgRef = useRef<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const addToast = useToastStore((s) => s.add);
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    let errorTimer: ReturnType<typeof setTimeout> | null = null;
    let container: HTMLDivElement | null = null;

    // code 稳定 RENDER_DEBOUNCE_MS 后才 render：流式中 code 每个 token 都变，
    // timer 不断重置 → render 不触发 → 已渲染的图保持稳定不闪。
    renderTimer = setTimeout(() => {
      if (cancelled) return;
      ensureInit();
      const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
      container = document.createElement("div");
      container.id = id;
      container.style.display = "none";
      document.body.appendChild(container);

      mermaid
        .render(id, code)
        .then((r) => {
          if (cancelled) return;
          // SVG diff：内容相同则不替换 DOM，避免无谓重画
          if (r.svg !== lastSvgRef.current) {
            lastSvgRef.current = r.svg;
            setSvg(r.svg);
          }
          setError(null);
        })
        .catch((err: any) => {
          if (cancelled) return;
          const msg = err?.message ?? String(err);
          setSvg(null);
          lastSvgRef.current = null;
          // 错误显示 debounce：render 失败后再等 ERROR_DEBOUNCE_MS 才显示
          errorTimer = setTimeout(() => {
            if (!cancelled) setError(msg);
          }, ERROR_DEBOUNCE_MS);
        });
    }, RENDER_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (renderTimer) clearTimeout(renderTimer);
      if (errorTimer) clearTimeout(errorTimer);
      if (container) container.remove();
    };
  }, [code]);

  // 拖拽
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
      setOffset({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
    },
    [dragging],
  );
  const onMouseUp = useCallback(() => setDragging(false), []);

  // 缩放
  const [scale, setScale] = useState(1);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const zoomIn = useCallback(
    () => setScale((s) => Math.min(MAX_SCALE, +(s + SCALE_STEP).toFixed(2))),
    [],
  );
  const zoomOut = useCallback(
    () => setScale((s) => Math.max(MIN_SCALE, +(s - SCALE_STEP).toFixed(2))),
    [],
  );

  // 用原生事件绑定 wheel 事件（passive: false），React 的 onWheel 是 passive 的无法 preventDefault。
  // viewport 元素是条件渲染（modalOpen 后才挂载），依赖 [modalOpen] 确保元素可用后再绑定，
  // 关闭时 cleanup 移除监听。
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY < 0) setScale((s) => Math.min(MAX_SCALE, +(s + SCALE_STEP).toFixed(2)));
      else setScale((s) => Math.max(MIN_SCALE, +(s - SCALE_STEP).toFixed(2)));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [modalOpen]);

  const openModal = useCallback(() => {
    setOffset({ x: 0, y: 0 });
    setScale(1);
    setModalOpen(true);
  }, []);

  // 复制
  const copyCode = useCallback(async () => {
    try {
      await copyToClipboard(code);
      addToast(t("blocks.mermaid.toastCodeCopied"), "success");
    } catch {
      addToast(t("common.copyFailed"), "error");
    }
  }, [code, addToast, t]);

  const copyImage = useCallback(async () => {
    if (!svg) return;
    try {
      const png = await svgToPngBlob(svg);
      await copyImageToClipboard(png);
      addToast(t("blocks.mermaid.toastImageCopied"), "success");
    } catch {
      addToast(t("common.copyFailed"), "error");
    }
  }, [svg, addToast, t]);

  if (error) {
    return (
      <div data-testid="mermaid-error" className="rounded-lg border border-hairline p-3 text-[calc(12px*var(--font-scale))] text-danger bg-surface my-1">
        {t("blocks.mermaid.renderError", { error })}
      </div>
    );
  }

  if (!svg) {
    return (
      <div data-testid="mermaid-loading" className="rounded-lg border border-hairline p-3 text-[calc(12px*var(--font-scale))] text-tertiary bg-surface my-1 text-center">
        {t("blocks.mermaid.loading")}
      </div>
    );
  }

  // 缩放/复制图标
  const zoomOutIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" /></svg>
  );
  const zoomInIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" /></svg>
  );
  const closeIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
  );

  return (
    <>
      <div className="rounded-lg border border-hairline overflow-x-auto p-3 bg-white my-1 relative group">
        <div className="w-full" data-testid="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
        <button
          type="button" data-testid="mermaid-zoom-btn" onClick={openModal}
          className="absolute right-1.5 top-1.5 w-6 h-6 rounded-md bg-surface-elevated border border-hairline flex items-center justify-center text-tertiary hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
          title={t("blocks.mermaid.tooltipZoomOpen")}
        >
          {zoomInIcon}
        </button>
      </div>

      {modalOpen && (
        <Modal width="85vw" height="85vh" onClose={() => setModalOpen(false)} data-testid="mermaid-modal">
          <div className="flex items-center px-4 py-2.5 border-b border-hairline shrink-0 gap-2">
            <span className="text-[calc(13px*var(--font-scale))] font-semibold text-primary">{t("blocks.mermaid.modalTitle")}</span>
            <span data-testid="mermaid-scale-label" className="text-[calc(12px*var(--font-scale))] text-tertiary tabular-nums min-w-[3em] text-center">
              {Math.round(scale * 100)}%
            </span>

            <button type="button" data-testid="mermaid-zoom-out" onClick={zoomOut} disabled={scale <= MIN_SCALE}
              className="w-6 h-6 rounded-md border border-hairline flex items-center justify-center text-tertiary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors" title={t("blocks.mermaid.tooltipZoomOut")}>{zoomOutIcon}</button>
            <button type="button" data-testid="mermaid-zoom-in" onClick={zoomIn} disabled={scale >= MAX_SCALE}
              className="w-6 h-6 rounded-md border border-hairline flex items-center justify-center text-tertiary hover:text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors" title={t("blocks.mermaid.tooltipZoomIn")}>{zoomInIcon}</button>

            {/* 右侧：复制 + 关闭 */}
            <span className="ml-auto" />

            <button type="button" data-testid="mermaid-copy-code" onClick={copyCode}
              className="w-6 h-6 rounded-md border border-hairline flex items-center justify-center text-tertiary hover:text-primary transition-colors" title={t("blocks.mermaid.tooltipCopyCode")}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" ry="1" /></svg>
            </button>
            <button type="button" data-testid="mermaid-copy-image" onClick={copyImage}
              className="w-6 h-6 rounded-md border border-hairline flex items-center justify-center text-tertiary hover:text-primary transition-colors" title={t("blocks.mermaid.tooltipCopyImage")}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            </button>

            <span className="w-px h-4 bg-hairline mx-1" />

            <button type="button" data-testid="mermaid-modal-close" onClick={() => setModalOpen(false)}
              className="w-7 h-7 rounded-md flex items-center justify-center text-tertiary hover:text-primary hover:bg-surface-hover transition-colors" title={t("common.close")}>{closeIcon}</button>
          </div>

          <div data-testid="mermaid-modal-viewport" className="flex-1 min-h-0 overflow-auto bg-[#f8f8f8]"
            ref={viewportRef} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
            <div data-testid="mermaid-modal-inner" className="inline-block min-w-full min-h-full p-8 select-none"
              style={{ cursor: dragging ? "grabbing" : "grab", transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transformOrigin: "0 0" }}
              onMouseDown={onMouseDown} dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
        </Modal>
      )}
    </>
  );
}
