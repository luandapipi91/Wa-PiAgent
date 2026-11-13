import { expect, test } from "bun:test";
import { parseDoctorOutput } from "../agent-browser-runtime";

const READY = JSON.stringify({
  checks: [
    {
      category: "Chrome",
      id: "chrome.installed",
      status: "pass",
      message:
        "Google Chrome 157 at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
  ],
  success: true,
});

const MISSING = JSON.stringify({
  checks: [
    { category: "Chrome", id: "chrome.installed", status: "fail", message: "Chrome not found" },
  ],
  success: false,
});

test("doctor 输出解析为 ready", () => {
  expect(parseDoctorOutput(READY)).toMatchObject({
    state: "ready",
    chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
});

test("doctor 输出解析为 missing", () => {
  expect(parseDoctorOutput(MISSING).state).toBe("missing");
});

test("畸形输出为 unknown", () => {
  expect(parseDoctorOutput("not json").state).toBe("unknown");
});
