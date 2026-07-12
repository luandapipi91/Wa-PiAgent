// 等端口进入 LISTEN，超时返回 false。复用 scripts/port.ts 的 isPortInUse 思路。
const { createServer } = require("node:net");

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port);
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

module.exports = { isPortInUse, waitForPort };
