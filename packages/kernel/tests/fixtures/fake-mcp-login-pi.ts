// fake-mcp-login-pi.ts — 测试用假 pi：模拟 `pi mcp login|logout` 的几种真实形态，
// 由 `MCP_LOGIN_TEST_MODE` 选择（ok / timeout / stdio / stderr-only / hang / logout-ok / logout-fail）。
//
// 为什么不 mock spawn：McpLoginRunner 的价值全在「真的 spawn、真的逐行读 stdout、真的按
// 授权 URL 的形态提取」（规格 F20），超时 kill 与 stderr 捕获这些分支要真子进程才测得出来。
//
// 另外两件事：
//   · 把 argv 与 PI_CODING_AGENT_DIR 追加进 `MCP_LOGIN_ARGV_FILE`——锁住「传的是哪条命令、
//     环境变量里给的是哪个凭据目录」；
//   · ok 模式真的往 `<agent-dir>/mcp-auth.json` 写一条**规范化键**（`String(new URL(url))`，
//     与 pi 一致，F19）的凭据——让「登录后 signedIn 变 true」这条链在假件上也能跑通。
//   · hang 模式用 `MCP_LOGIN_ACTIVITY_FILE` 持续留痕：测试以「kill 后文件不再增长」作为
//     子进程真被杀掉的证据。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.MCP_LOGIN_TEST_MODE ?? "ok";
const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
/** pi 打到 stdout 的授权 URL */
const url = process.env.MCP_LOGIN_TEST_URL ?? "http://127.0.0.1:59998/authorize?client_id=x";
/** 写进 mcp-auth.json 的键（= 配置里的 server URL，与授权 URL 是两回事）；缺省与 url 相同 */
const serverUrl = process.env.MCP_LOGIN_TEST_SERVER_URL ?? url;

const dumpFile = process.env.MCP_LOGIN_ARGV_FILE;
if (dumpFile) {
  try {
    appendFileSync(
      dumpFile,
      JSON.stringify({ argv: process.argv.slice(2), agentDir }) + "\n",
      "utf8",
    );
  } catch {
    /* 留痕失败不影响被测行为 */
  }
}

const activityFile = process.env.MCP_LOGIN_ACTIVITY_FILE;
function tick(): void {
  if (!activityFile) return;
  try {
    appendFileSync(activityFile, `${process.pid}\n`, "utf8");
  } catch {
    /* 同上 */
  }
}
tick();

/** 按 pi 的做法写凭据：键是 `String(new URL(url))` 规范化后的 server URL */
function writeAuthEntry(): void {
  if (!agentDir) return;
  const file = join(agentDir, "mcp-auth.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    current = {};
  }
  current[String(new URL(serverUrl))] = { tokens: { access_token: "fake-token" } };
  writeFileSync(file, JSON.stringify(current), "utf8");
}

function removeAuthEntry(): boolean {
  if (!agentDir) return false;
  const file = join(agentDir, "mcp-auth.json");
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  const key = String(new URL(serverUrl));
  if (!(key in current)) return false;
  delete current[key];
  writeFileSync(file, JSON.stringify(current), "utf8");
  return true;
}

if (mode === "timeout") {
  // pi 的真实形态（POC）：先把授权 URL 打出来，等不到授权码后在 timeout 到点退 1
  process.stdout.write(`Sign in to MCP server "srv" in your browser:\n${url}\n`);
  process.stdout.write("cancelled or not completed within 3 seconds\n");
  process.exitCode = 1;
} else if (mode === "stdio") {
  // stdio 服务器：明确拒绝，且原因只打在 stderr 上
  process.stderr.write(
    `MCP server "srv" does not use OAuth. Only HTTP servers without an Authorization header do.\n`,
  );
  process.exitCode = 1;
} else if (mode === "stderr-only") {
  process.stderr.write("failed to connect to MCP server\n");
  process.exitCode = 1;
} else if (mode === "hang") {
  // 永不退出、持续留痕：模拟 pi 卡死在等待上（只能靠 runner 的宽限 kill 收场）
  setInterval(tick, 20);
} else if (mode === "logout-ok") {
  const removed = removeAuthEntry();
  process.stdout.write(removed ? "Signed out.\n" : "No credentials found.\n");
} else if (mode === "logout-fail") {
  process.stderr.write('MCP server "ghost" not found\n');
  process.exitCode = 1;
} else {
  // ok：说明行 + URL 行（与 POC 一致），并真的把凭据落盘
  process.stdout.write(`Sign in to MCP server "srv" in your browser:\n${url}\n`);
  writeAuthEntry();
}
// 不使用 process.exit()：非 hang 分支自然退出（避免管道未 flush 就截断 stdout）
