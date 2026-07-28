import { test, expect } from "bun:test";
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
