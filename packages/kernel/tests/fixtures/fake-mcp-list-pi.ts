// fake-mcp-list-pi.ts — 测试用假 pi：模拟 `pi mcp list --json` 的三种行为，
// 由 `MCP_ADMIN_TEST_MODE` 选择（ok / garbage / utf8 / hang）。
//
// 为什么不 mock：McpAdmin 的价值全在「真的 spawn、真的解析 stdout」（F14），
// 超时与缓存回退这些分支要一个真会卡住的子进程才测得出来。
// 真实 pi 的输出形态由 tests/mcp-admin-spawn.test.ts 里的对照用例锁住。
import { appendFileSync } from "node:fs";

// 存活痕迹：启动即留一行，hang 模式下每 20ms 再留一行。
// 测试以「kill 后文件不再增长」作为子进程真被杀掉的证据。
const activityFile = process.env.MCP_ADMIN_ACTIVITY_FILE;
function tick(): void {
  if (!activityFile) return;
  try {
    appendFileSync(activityFile, `${process.pid}\n`, "utf8");
  } catch {
    /* 留痕失败不影响被测行为 */
  }
}
tick();

const mode = process.env.MCP_ADMIN_TEST_MODE ?? "ok";

if (mode === "garbage") {
  // stdout 不是 JSON（模拟 pi 进程活着但输出了一片噪声）
  process.stdout.write("pi mcp list: cannot parse mcp.json\n");
} else if (mode === "utf8") {
  // 中文内容：锁定 stdout 按 UTF-8 解码（规格 §7）
  process.stdout.write(
    JSON.stringify({
      servers: [],
      errors: ["配置损坏：mcp.json 第 1 行无法解析"],
    }),
  );
} else if (mode === "hang") {
  // 永不退出、持续留痕：模拟 pi 卡在某台 server 上（只能靠超时 + kill 收场）
  setInterval(tick, 20);
} else {
  // 正常形态：一台 connected 的 server + 空 errors
  process.stdout.write(
    JSON.stringify({
      servers: [
        {
          name: "srv",
          scope: "global",
          source: "/tmp/mcp.json",
          enabled: true,
          exposure: "direct",
          transport: "fake-cmd",
          state: "connected",
          tools: ["t1", "t2"],
        },
      ],
      errors: [],
    }),
  );
}
// 不使用 process.exit()：非 hang 分支自然退出（避免管道未 flush 就截断 stdout）
