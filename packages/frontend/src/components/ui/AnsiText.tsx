import type { CSSProperties, ReactNode } from "react";
import {
	applySgrCodes,
	splitByCellWidth,
	stripOsc,
	type SgrAttrs,
} from "../../lib/tui-ansi";

// 16 色 foreground 映射（对齐 WaPi 语义色板，无对应时用近似 hex）
const FG_16: Record<number, string> = {
  30: "#1d1d1f", // black → text-primary
  31: "#dc2626", // red → danger
  32: "#34a853", // green → success
  33: "#b45309", // yellow → warning
  34: "#2563eb", // blue
  35: "#9333ea", // magenta
  36: "#0891b2", // cyan
  37: "#6e6e73", // white → text-secondary
  90: "#6e6e73", // bright black (gray)
  91: "#ef4444", // bright red
  92: "#4ade80", // bright green
  93: "#fbbf24", // bright yellow
  94: "#60a5fa", // bright blue
  95: "#c084fc", // bright magenta
  96: "#22d3ee", // bright cyan
  97: "#1d1d1f", // bright white
};

// xterm 256 色：0-15 为系统色，16-231 为 6×6×6 cube，232-255 为灰度
function xterm256(n: number): string {
  if (n < 16) {
    const system = [
      "#000000","#800000","#008000","#808000","#000080","#800080","#008080","#c0c0c0",
      "#808080","#ff0000","#00ff00","#ffff00","#0000ff","#ff00ff","#00ffff","#ffffff",
    ];
    return system[n] ?? "#000000";
  }
  if (n < 232) {
    const idx = n - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    const toHex = (v: number) => (v === 0 ? 0 : 55 + v * 40).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  const gray = 8 + (n - 232) * 10;
  const hex = gray.toString(16).padStart(2, "0");
  return `#${hex}${hex}${hex}`;
}

/**
 * 非颜色 SGR 属性 → inline style。无属性时返回 undefined，避免产生多余的 style 对象。
 */
function attrsToStyle(a: SgrAttrs): CSSProperties | undefined {
  if (!a.bold && !a.dim && !a.italic && !a.underline && !a.inverse) return undefined;
  return {
    ...(a.bold ? { fontWeight: 600 } : {}),
    ...(a.dim ? { opacity: 0.65 } : {}),
    ...(a.italic ? { fontStyle: "italic" } : {}),
    ...(a.underline ? { textDecoration: "underline" } : {}),
    ...(a.inverse ? { filter: "invert(1)" } : {}),
  };
}

export interface ParseAnsiOptions {
  /**
   * 是否把非颜色 SGR 属性（粗体/暗/斜体/下划线/反显）渲染成 inline style。
   *
   * 默认 false，保持本函数的历史契约：只解析颜色，其余 SGR 一律丢弃
   * （`tests/ansi-text.test.ts` 的「非法/不支持的序列被丢弃」断言依赖此行为）。
   * 面板渲染路径（`AnsiText` 组件）传 true。
   */
  attrs?: boolean;
  /**
   * 一格宽度（px）；传入时按终端语义把**全角字符渲染成 2 格宽**：每个全角字符包一个
   * 固定宽度的行内块（宽 = 2 × cellWidth）。浏览器里 CJK 的前进宽由回退字体决定
   * （≈ 1.67 格 ≠ 终端的 2 格），不校正会让含中文的帧行整体错位——详见 `isWideChar`。
   *
   * 不传则完全保持原有输出（其它消费者不受影响）：没有全角字符的行也只多一次扫描。
   */
  cellWidth?: number;
}

/**
 * 按终端列宽把纯文本切成 ReactNode：全角字符各占一格**宽 2 格**的行内块，其余原样输出。
 * 文本里没有全角字符时返回单个字符串（保持旧输出，不产生多余节点与换行影响）。
 * `nextKey` 由调用方提供，与其它节点共用一套 key。
 */
function cellNodes(
  text: string,
  cellWidth: number,
  nextKey: () => number,
): ReactNode[] {
  const runs = splitByCellWidth(text);
  if (runs.length === 1 && !runs[0].wide) return [text];
  return runs.flatMap((run) =>
    run.wide
      ? [...run.text].map((ch) => (
          <span
            key={nextKey()}
            data-tui-wide="1"
            style={{ display: "inline-block", width: 2 * cellWidth }}
          >
            {ch}
          </span>
        ))
      : [run.text],
  );
}

/**
 * 把带 ANSI SGR 码的字符串解析为 ReactNode 数组。
 *
 * 处理颜色（foreground/background）与可选的 `attrs`；非 SGR 控制序列一律丢弃，
 * OSC 序列先由 `stripOsc` 统一剥掉（OSC 8 的可见文本保留，标记丢弃）。
 */
export function parseAnsiToNodes(text: string, options: ParseAnsiOptions = {}): ReactNode[] {
  const withAttrs = options.attrs === true;
  const cellWidth = options.cellWidth;
  const clean = stripOsc(text);
  let key = 0;
  const nextKey = () => key++;
  if (!clean.includes("\x1b[")) {
    return cellWidth ? cellNodes(clean, cellWidth, nextKey) : [clean];
  }

  const nodes: ReactNode[] = [];
  let fg: string | null = null;
  let bg: string | null = null;
  let attrs: SgrAttrs = {};
  let buffer = "";

  const flush = () => {
    if (!buffer) return;
    const attrStyle = withAttrs ? attrsToStyle(attrs) : undefined;
    const children: ReactNode = cellWidth
      ? cellNodes(buffer, cellWidth, nextKey)
      : buffer;
    if (fg || bg || attrStyle) {
      nodes.push(
        <span key={nextKey()} style={{ color: fg ?? undefined, background: bg ?? undefined, ...attrStyle }}>
          {children}
        </span>,
      );
    } else if (typeof children === "string") {
      // 无样式的相邻纯文本合并为一个字符串节点，避免产生冗余片段
      const last = nodes[nodes.length - 1];
      if (typeof last === "string") {
        nodes[nodes.length - 1] = last + children;
      } else {
        nodes.push(children);
      }
    } else {
      // 已按格宽分段的节点各自带 key，直接平铺（分段本身就是分段，不再合并）
      nodes.push(...children);
    }
    buffer = "";
  };

  // 按 \x1b[ 切分，逐段解析 SGR 序列
  const parts = clean.split(/(\x1b\[[0-9;?]*[A-Za-z])/);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("\x1b[")) {
      flush();
      const match = part.match(/\x1b\[([0-9;?]*)([A-Za-z])/);
      if (!match) continue;
      const [, params, cmd] = match;
      if (cmd !== "m") continue; // 只处理 SGR

      const codes = params.split(";").map((s) => parseInt(s, 10));
      // 非颜色属性交给 tui-ansi 维护（同一份属性码语义，避免两处重复实现）。
      // 注：这里沿用颜色分支的解析习惯——`ESC[m`（空参数）是空码列表，不做重置。
      if (withAttrs) attrs = applySgrCodes(attrs, codes.filter((n) => Number.isFinite(n)));
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (Number.isNaN(code)) continue;
        if (code === 0) { fg = null; bg = null; }
        else if (code === 39) { fg = null; }
        else if (code === 49) { bg = null; }
        else if (code >= 30 && code <= 37) { fg = FG_16[code] ?? null; }
        else if (code >= 90 && code <= 97) { fg = FG_16[code] ?? null; }
        else if (code >= 40 && code <= 47) { bg = FG_16[code - 10] ?? null; }
        else if (code >= 100 && code <= 107) { bg = FG_16[code - 10] ?? null; }
        else if (code === 38 || code === 48) {
          const isFg = code === 38;
          if (codes[i + 1] === 5 && typeof codes[i + 2] === "number") {
            const color = xterm256(codes[i + 2]);
            if (isFg) fg = color; else bg = color;
            i += 2;
          } else if (codes[i + 1] === 2 && typeof codes[i + 2] === "number" && typeof codes[i + 3] === "number" && typeof codes[i + 4] === "number") {
            const r = codes[i + 2].toString(16).padStart(2, "0");
            const g = codes[i + 3].toString(16).padStart(2, "0");
            const b = codes[i + 4].toString(16).padStart(2, "0");
            const color = `#${r}${g}${b}`;
            if (isFg) fg = color; else bg = color;
            i += 4;
          }
        }
      }
      continue;
    }
    buffer += part;
  }
  flush();
  return nodes;
}

export function AnsiText({
  text,
  cellWidth,
}: {
  text: string;
  /** 见 `ParseAnsiOptions.cellWidth`：面板帧传实测格宽让全角字符占 2 格 */
  cellWidth?: number;
}) {
  return <>{parseAnsiToNodes(text, { attrs: true, cellWidth })}</>;
}
