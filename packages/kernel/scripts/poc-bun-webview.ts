/**
 * POC: 验证 Bun.WebView 在 wa-pi 环境的关键能力
 *
 * 验证点：
 *  1. JS 渲染抓取（本地 HTTP 页 + setTimeout 渲染，验证 fetch 抓不到的动态内容）
 *  2. 原生交互 isTrusted（click 触发 onclick，读取 event.isTrusted）
 *  3. type 输入（InsertText 编辑命令生效）
 *  4. 连续操作状态保持（同一视图 navigate→click→type→screenshot）
 *  5. 截图有效性（PNG magic bytes）
 *  6. 多实例隔离（两个视图各自独立，状态互不影响）
 *  7. close 销毁（close 后操作抛 ERR_INVALID_STATE）
 *
 * 运行：bun run packages/kernel/scripts/poc-bun-webview.ts
 */
import { serve } from "bun";

// ---- 本地测试页 ----
const server = serve({
  port: 0,
  fetch(req) {
    let pathname: string;
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (pathname === "/") {
      return new Response(
        `<!DOCTYPE html>
<html><head><title>POC Page</title></head>
<body>
  <div id="app">initial</div>
  <button id="btn" onclick="document.getElementById('app').textContent='clicked-by-'+event.isTrusted">Click me</button>
  <input id="input" />
  <div id="output"></div>
  <script>
    // 模拟 JS 动态渲染（HTTP fetch 拿不到，必须真实浏览器执行）
    setTimeout(() => {
      document.getElementById("app").textContent = "rendered-by-js";
    }, 50);
    document.getElementById("input").addEventListener("input", (e) => {
      document.getElementById("output").textContent = "typed:" + e.target.value;
    });
  </script>
</body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return new Response("not found", { status: 404 });
  },
});

const base = `http://127.0.0.1:${server.port}`;
let passed = 0;
let failed = 0;
function check(name: string, cond: unknown, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${extra ? `  (${extra})` : ""}`);
  }
}

console.log("=== POC 1: JS 渲染抓取 + 原生交互（同一视图连续操作）===");
const view = new Bun.WebView({ width: 800, height: 600 });
try {
  await view.navigate(`${base}/`);
  check("navigate 返回", view.url === `${base}/`, view.url);

  await Bun.sleep(200); // 等 setTimeout 渲染
  const appText = await view.evaluate(
    `document.getElementById("app").textContent`,
  );
  check("抓取到 JS 渲染内容", appText === "rendered-by-js", `got: ${appText}`);

  await view.click("#btn");
  const afterClick = await view.evaluate(
    `document.getElementById("app").textContent`,
  );
  check(
    "click 原生事件生效(isTrusted=true)",
    afterClick === "clicked-by-true",
    `got: ${afterClick}`,
  );

  await view.click("#input");
  await view.type("hello-poc");
  const typed = await view.evaluate(
    `document.getElementById("output").textContent`,
  );
  check("type 输入生效", typed === "typed:hello-poc", `got: ${typed}`);

  const title = await view.evaluate("document.title");
  check("title 获取", title === "POC Page", String(title));
} catch (e) {
  failed++;
  console.error("  ❌ POC 1 异常:", (e as Error).message);
} finally {
  view.close();
}

console.log("=== POC 2: 截图有效性（PNG magic bytes）===");
try {
  const v = new Bun.WebView({ width: 400, height: 300 });
  await v.navigate(`${base}/`);
  await Bun.sleep(100);
  const shot = await v.screenshot({ encoding: "buffer" });
  const isPng =
    shot[0] === 0x89 &&
    shot[1] === 0x50 &&
    shot[2] === 0x4e &&
    shot[3] === 0x47;
  check(
    "screenshot 返回有效 PNG",
    isPng && shot.length > 100,
    `len: ${shot.length}`,
  );
  await Bun.write("/tmp/poc-webview.png", shot);
  console.log(`  截图已保存 /tmp/poc-webview.png (${shot.length} bytes)`);
  const b64 = await v.screenshot({ encoding: "base64" });
  check(
    "base64 编码可用",
    typeof b64 === "string" && b64.length > 100,
    `len: ${b64.length}`,
  );
  v.close();
} catch (e) {
  failed++;
  console.error("  ❌ POC 2 异常:", (e as Error).message);
}

console.log("=== POC 3: 多实例隔离（不同会话独立 tab/view）===");
try {
  const v1 = new Bun.WebView({ width: 400, height: 300 });
  const v2 = new Bun.WebView({ width: 400, height: 300 });
  await Promise.all([v1.navigate(`${base}/`), v2.navigate(`${base}/`)]);
  await Bun.sleep(200);
  await v1.evaluate(`document.getElementById("app").textContent = "session-A"`);
  const a = await v1.evaluate(`document.getElementById("app").textContent`);
  const b = await v2.evaluate(`document.getElementById("app").textContent`);
  check(
    "两个视图状态隔离",
    a === "session-A" && b === "rendered-by-js",
    `a=${a} b=${b}`,
  );
  v1.close();
  v2.close();
} catch (e) {
  failed++;
  console.error("  ❌ POC 3 异常:", (e as Error).message);
}

console.log("=== POC 4: close 销毁 ===");
try {
  const v3 = new Bun.WebView();
  await v3.navigate("about:blank");
  v3.close();
  let threw = false;
  try {
    await v3.evaluate("1+1");
  } catch {
    threw = true;
  }
  check("close 后操作抛错", threw);
} catch (e) {
  failed++;
  console.error("  ❌ POC 4 异常:", (e as Error).message);
}

server.stop();
console.log(`\n===== POC 结果: ${passed} 通过, ${failed} 失败 =====`);
process.exit(failed > 0 ? 1 : 0);
