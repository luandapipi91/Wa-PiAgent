// argv-dump-pi.ts — 测试用 pi rpc 包装进程：
// 1. 把 process.argv 追加写入 ARGV_DUMP_FILE 指定的文件（供测试断言启动参数）；
// 2. 之后按最小 rpc 协议工作：prompt → 立即 settled（无文本输出）。
import { appendFileSync } from "node:fs";

const dumpFile = process.env.ARGV_DUMP_FILE;
if (dumpFile) {
  try { appendFileSync(dumpFile, JSON.stringify(process.argv.slice(2)) + "\n", "utf8"); } catch {}
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer | string) => {
  buffer += chunk.toString();
  for (;;) {
    const idx = buffer.indexOf("\n");
    if (idx === -1) break;
    let line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    let cmd: any;
    try { cmd = JSON.parse(line); } catch { continue; }
    if (cmd.type === "prompt") {
      emit({ id: cmd.id, type: "response", command: "prompt", success: true });
      emit({ type: "agent_start" });
      emit({ type: "agent_settled" });
    } else {
      emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: {} });
    }
  }
});
