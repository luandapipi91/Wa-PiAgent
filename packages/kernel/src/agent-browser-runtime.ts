// agent-browser 运行时探测与浏览器安装。
//
// 就绪判断完全交给 agent-browser 自己的 doctor（不写 Chrome 探测代码）；
// 安装只在用户显式触发时执行，逐行把进度回传给 UI。
import { spawn as nodeSpawn } from "node:child_process";

export type BrowserReadiness = "ready" | "missing" | "unknown";

export interface BrowserStatus {
  state: BrowserReadiness;
  message?: string;
  chromePath?: string;
}

export interface RuntimeOpts {
  /** 测试注入 */
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
}

/** 解析 `agent-browser doctor --offline --quick --json` 的输出（纯函数） */
export function parseDoctorOutput(stdout: string): BrowserStatus {
  try {
    const parsed = JSON.parse(stdout) as {
      checks?: Array<{ id?: string; status?: string; message?: string }>;
    };
    const check = parsed.checks?.find((c) => c.id === "chrome.installed");
    if (!check) return { state: "unknown" };
    if (check.status === "pass") {
      const matched = / at (.+)$/.exec(check.message ?? "");
      return {
        state: "ready",
        ...(matched ? { chromePath: matched[1] } : {}),
      };
    }
    if (check.status === "fail") {
      return { state: "missing", message: check.message };
    }
    return { state: "unknown", message: check.message };
  } catch {
    return { state: "unknown" };
  }
}

/** 跑一次 doctor；spawn 失败/超时/输出不可解析都归为 unknown */
export async function checkBrowserReadiness(
  binary: string,
  opts: RuntimeOpts = {},
): Promise<BrowserStatus> {
  const spawn = opts.spawn ?? nodeSpawn;
  return await new Promise<BrowserStatus>((resolve) => {
    let settled = false;
    const finish = (status: BrowserStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    let child;
    try {
      child = spawn(binary, ["doctor", "--offline", "--quick", "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ state: "unknown", message: "agent-browser 无法执行" });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill?.();
      finish({ state: "unknown", message: "doctor 超时" });
    }, opts.timeoutMs ?? 10_000);
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.on("error", () =>
      finish({ state: "unknown", message: "agent-browser 无法执行" }),
    );
    child.on("close", () => {
      const parsed = parseDoctorOutput(stdout);
      if (parsed.state === "unknown" && stderr.trim()) {
        parsed.message = stderr.trim().slice(-300);
      }
      finish(parsed);
    });
  });
}

/** 执行 `agent-browser install`（下载 Chrome for Testing），逐行回传输出 */
export function installBrowser(
  binary: string,
  onLine: (line: string) => void,
  opts: RuntimeOpts = {},
): Promise<void> {
  const spawn = opts.spawn ?? nodeSpawn;
  return new Promise<void>((resolve, reject) => {
    let tail = "";
    let child;
    try {
      child = spawn(binary, ["install"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      reject(new Error(`agent-browser install 无法执行: ${String(e)}`));
      return;
    }
    const handle = (b: Buffer) => {
      const text = b.toString();
      tail = (tail + text).slice(-600);
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    };
    child.stdout?.on("data", handle);
    child.stderr?.on("data", handle);
    child.on("error", (e) => reject(new Error(`agent-browser install 无法执行: ${String(e)}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`agent-browser install 退出码 ${code}\n${tail}`));
    });
  });
}
