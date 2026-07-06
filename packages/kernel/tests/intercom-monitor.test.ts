import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { IntercomMonitor } from "../src/intercom-monitor";

const SOCK = `${process.env.HOME}/.pi/agent/intercom/broker.sock`;

test("IntercomMonitor connect 后 listSessions 非空", async () => {
  // Ensure broker exists by spawning a pi to auto-spawn it
  if (!existsSync(SOCK)) {
    const pi = spawn("node", [
      `${process.env.HOME}/.nvm/versions/node/v22.21.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`,
      "--mode", "rpc", "--name", "im-fixture", "--no-tools",
    ], { env: { ...process.env } });
    for (let i = 0; i < 20 && !existsSync(SOCK); i++) await new Promise(r => setTimeout(r, 500));
    await new Promise(r => setTimeout(r, 1000));
    pi.kill("SIGKILL");
  }

  const mon = new IntercomMonitor();
  await mon.connect();
  const sessions = await mon.listSessions();
  await mon.disconnect();
  expect(Array.isArray(sessions)).toBe(true);
  expect(sessions.length).toBeGreaterThan(0);
}, 30000);
