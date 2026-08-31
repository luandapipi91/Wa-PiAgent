import type { ReactNode } from "react";

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
 * 把带 ANSI SGR 颜色码的字符串解析为 ReactNode 数组。
 * 仅处理颜色（foreground/background），其他控制序列丢弃。
 */
export function parseAnsiToNodes(text: string): ReactNode[] {
  if (!text.includes("\x1b[")) return [text];

  const nodes: ReactNode[] = [];
  let fg: string | null = null;
  let bg: string | null = null;
  let buffer = "";
  let key = 0;

  const flush = () => {
    if (!buffer) return;
    if (fg || bg) {
      nodes.push(
        <span key={key++} style={{ color: fg ?? undefined, background: bg ?? undefined }}>
          {buffer}
        </span>,
      );
    } else {
      // 无样式的相邻纯文本合并为一个字符串节点，避免产生冗余片段
      const last = nodes[nodes.length - 1];
      if (typeof last === "string") {
        nodes[nodes.length - 1] = last + buffer;
      } else {
        nodes.push(buffer);
      }
    }
    buffer = "";
  };

  // 按 \x1b[ 切分，逐段解析 SGR 序列
  const parts = text.split(/(\x1b\[[0-9;?]*[A-Za-z])/);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("\x1b[")) {
      flush();
      const match = part.match(/\x1b\[([0-9;?]*)([A-Za-z])/);
      if (!match) continue;
      const [, params, cmd] = match;
      if (cmd !== "m") continue; // 只处理 SGR

      const codes = params.split(";").map((s) => parseInt(s, 10));
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

export function AnsiText({ text }: { text: string }) {
  return <>{parseAnsiToNodes(text)}</>;
}
