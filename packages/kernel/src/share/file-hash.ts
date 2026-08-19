// Cloudflare Pages 内容寻址 hash：与 wrangler hashFile 完全一致
// blake3(base64(内容) + 扩展名).hex.slice(0, 32)
import { blake3 } from "@noble/hashes/blake3.js";

export function hashFileContent(content: Uint8Array, ext: string): string {
  const base64Contents = Buffer.from(content).toString("base64");
  const extension = ext.replace(/^\./, ""); // 不带点
  const digest = blake3(new TextEncoder().encode(base64Contents + extension));
  return Buffer.from(digest).toString("hex").slice(0, 32);
}
