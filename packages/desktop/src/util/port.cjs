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

/** 从 startPort 开始顺序探测，返回第一个可用端口 */
async function findAvailablePort(startPort, maxTries = 100) {
  for (let i = 0; i < maxTries; i++) {
    const port = startPort + i;
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error(`未找到可用端口（${startPort} ~ ${startPort + maxTries - 1}）`);
}

module.exports = { isPortInUse, waitForPort, findAvailablePort };
