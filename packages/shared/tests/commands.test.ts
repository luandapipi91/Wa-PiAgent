import { test, expect } from "bun:test";
import { KERNEL_INTERCEPTED_COMMANDS, matchKernelCommand } from "../src";
import type {
  CommandInfo,
  CommandSource,
  SessionCommandsRequest,
  SessionCommandsResult,
  WSClientEvent,
  WSServerEvent,
} from "../src";

test("CommandSource 涵盖 pi get_commands 返回的全部来源 + builtin", () => {
  const sources: CommandSource[] = ["extension", "prompt", "skill", "builtin"];
  for (const s of sources) {
    expect(typeof s).toBe("string");
  }
});

test("CommandInfo 最小结构（name 必填，description/source 可选但 source 有字面量约束）", () => {
  const cmd: CommandInfo = { name: "goal", description: "设定目标", source: "extension" };
  expect(cmd.name).toBe("goal");
  expect(cmd.source).toBe("extension");
});

test("CommandInfo 新增 extension 来源可选字段（packageName/enabled）", () => {
  const cmd: CommandInfo = {
    name: "goal",
    source: "extension",
    packageName: "@narumitw/pi-goal",
    enabled: true,
  };
  expect(cmd.packageName).toBe("@narumitw/pi-goal");
  expect(cmd.enabled).toBe(true);
});

test("SessionCommandsRequest 字面量 type 与 ws-server case 一致", () => {
  const req: SessionCommandsRequest = { type: "session:commands", sessionId: "s1" };
  expect(req.type).toBe("session:commands");
  // 验证可赋值给 WSClientEvent 联合（编译期保证 type 字面量在联合内）
  const e: WSClientEvent = req;
  expect(e.type).toBe("session:commands");
});

test("SessionCommandsResult 字面量 type 与 ws-server reply 一致", () => {
  const res: SessionCommandsResult = {
    type: "session:commands",
    sessionId: "s1",
    commands: [{ name: "goal", source: "extension" }],
  };
  expect(res.type).toBe("session:commands");
  expect(res.commands).toHaveLength(1);
  // 验证可赋值给 WSServerEvent 联合
  const e: WSServerEvent = res;
  expect(e.type).toBe("session:commands");
});

test("matchKernelCommand：命中内置命令（含自定义指令）返回命令名", () => {
  expect(matchKernelCommand("/compact")).toBe("compact");
  expect(matchKernelCommand("/compact 只保留关键决策")).toBe("compact");
  // 前后空白耐受（text.trim()）
  expect(matchKernelCommand("  /compact  ")).toBe("compact");
});

test("matchKernelCommand：非内置命令 / 同前缀词 / 普通文本不命中", () => {
  // 同前缀词不误伤
  expect(matchKernelCommand("/compactify")).toBe(null);
  // 未列入 KERNEL_INTERCEPTED_COMMANDS 的命令
  expect(matchKernelCommand("/goal")).toBe(null);
  expect(matchKernelCommand("/model gpt-4o")).toBe(null);
  // 普通文本与非 / 开头
  expect(matchKernelCommand("你好")).toBe(null);
  expect(matchKernelCommand("compact")).toBe(null);
  expect(matchKernelCommand("")).toBe(null);
});

test("KERNEL_INTERCEPTED_COMMANDS 与 matchKernelCommand 保持一致", () => {
  // 清单中每条命令都必须能被匹配函数命中（防清单与正则漂移）
  for (const name of KERNEL_INTERCEPTED_COMMANDS) {
    expect(matchKernelCommand(`/${name}`)).toBe(name);
  }
});
