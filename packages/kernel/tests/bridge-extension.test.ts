// bridge-extension.test.ts —— wa-pi-bridge.extension callBridge 流式 NDJSON 读取测试
//
// 该文件测源扩展的 callBridge（经 delegate 工具 execute 间接调用）：
// - mock globalThis.fetch 返回 NDJSON ReadableStream
// - 注入 bridge 环境变量
// - 复用 bridge.test.ts 的成熟套路：把源扩展写到临时 .ts 文件 + 复制 tool-schemas
//   到同目录（源扩展的 `import "./tool-schemas.ts"` 才能解析），再动态 import 临时文件。
//
// 复制 generateBridgeExtension 源码而不是直接 import 源文件的原因：源文件在
// packages/kernel/src 下，同目录没有 tool-schemas.ts（该文件运行期才复制到 GENERATED_DIR）。

import { test, expect, afterAll } from "bun:test";
import { writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateBridgeExtension } from "../src/bridge-extension";

// 临时文件清单，测试结束统一清理
const tmpFiles: string[] = [];
afterAll(() => {
  for (const f of tmpFiles) rmSync(f, { force: true });
});

/** 加载扩展（复制 schema + 源码到临时文件，再动态 import），返回注册的工具数组。 */
async function loadTools(): Promise<any[]> {
  const file = join(import.meta.dir, `.tmp-bridge-ext-${Math.random().toString(36).slice(2)}.ts`);
  const schemasFile = join(import.meta.dir, "tool-schemas.ts");
  const schemasSrc = join(import.meta.dir, "..", "..", "shared", "src", "tool-schemas.ts");
  copyFileSync(schemasSrc, schemasFile);
  tmpFiles.push(schemasFile);
  writeFileSync(file, generateBridgeExtension(), "utf8");
  tmpFiles.push(file);
  const mod = await import(pathToFileURL(file).href);
  const tools: any[] = [];
  mod.default({ registerTool: (def: any) => tools.push(def) });
  return tools;
}

/** 构造一个 NDJSON ReadableStream。 */
function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const payload = enc.encode(lines.join("\n") + "\n");
  return new ReadableStream({
    start(c) {
      c.enqueue(payload);
      c.close();
    },
  });
}

/** 注入 bridge env。 */
function injectBridgeEnv() {
  process.env.WA_PI_BRIDGE_URL = "http://test";
  process.env.WA_PI_BRIDGE_TOKEN = "t";
  process.env.WA_PI_SESSION_ID = "s";
}

/** mock fetch 返回给定 NDJSON 行流。返回恢复函数。 */
function mockNdjsonFetch(lines: string[]): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    // 流式协议标识：content-type 含 x-ndjson
    headers: new Headers({ "content-type": "application/x-ndjson" }),
    body: ndjsonStream(lines),
    json: async () => ({}),
  })) as any;
  return () => {
    globalThis.fetch = orig;
  };
}

test("delegate execute 读取 NDJSON 流并组装最终结果", async () => {
  const restore = mockNdjsonFetch([
    JSON.stringify({ type: "started", protocol: 1, tool: "delegate", toolCallId: "tc1" }),
    JSON.stringify({
      type: "progress",
      tool: "delegate",
      toolCallId: "tc1",
      progress: { agent: "a", status: "running", output: "x", tools: [], elapsedMs: 1 },
    }),
    JSON.stringify({
      type: "final",
      tool: "delegate",
      toolCallId: "tc1",
      ok: true,
      result: { content: [{ type: "text", text: "子代理结果" }] },
    }),
  ]);
  injectBridgeEnv();

  try {
    const tools = await loadTools();
    const delegateTool = tools.find((t) => t.name === "delegate");
    const res = await delegateTool.execute(
      "tc1",
      { agent: "general-purpose", task: "hi" },
      new AbortController().signal,
    );
    expect(res.content[0].text).toBe("子代理结果");
  } finally {
    restore();
  }
});

test("流中断（无 final）退化为错误结果", async () => {
  const restore = mockNdjsonFetch([
    JSON.stringify({ type: "started", protocol: 1, tool: "delegate", toolCallId: "tc2" }),
  ]);
  injectBridgeEnv();

  try {
    const tools = await loadTools();
    const delegateTool = tools.find((t) => t.name === "delegate");
    const res = await delegateTool.execute(
      "tc2",
      { agent: "general-purpose", task: "hi" },
      new AbortController().signal,
    );
    expect(res.details?.error).toBe("stream_interrupted");
    expect(res.content[0].text).toContain("连接中断");
  } finally {
    restore();
  }
});
