// 知识库存储路径：<WA_PI_DIR>/knowledge.db（总登记库）+
// <WA_PI_DIR>/knowledge/<kbId>.db（每库独立库）。
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** 总登记库路径 */
export function knowledgeDbPath(waPiDir: string): string {
  return join(waPiDir, "knowledge.db");
}

/** 每库独立 db 目录（mkdir -p 语义） */
export function knowledgeDir(waPiDir: string): string {
  const dir = join(waPiDir, "knowledge");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 某个知识库的每库独立 db 文件路径 */
export function kbDbPath(waPiDir: string, kbId: string): string {
  return join(knowledgeDir(waPiDir), `${kbId}.db`);
}
