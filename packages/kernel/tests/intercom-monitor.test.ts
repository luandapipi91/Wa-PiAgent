import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { IntercomMonitor } from "../src/intercom-monitor";
import type { AskItem } from "@hiagent/shared";

function mockSocket() {
  const ee = new EventEmitter();
  const sock = Object.assign(ee, {
    writeBuf: "",
    write: (s: string) => { sock.writeBuf += s; },
    end: () => {},
    destroyed: false,
    // 测试辅助
    emitMsg: (obj: unknown) => sock.emit("data", Buffer.from(JSON.stringify(obj) + "\n")),
  });
  return sock;
}

test("connect 后收 ask → onAsk", async () => {
  const sock = mockSocket() as any;
  const asks: AskItem[] = [];
  const mon = new IntercomMonitor({
    onAsk: a => asks.push(a),
    onReply: () => {},
    connectFn: async () => sock,
  });
  await mon.connect();
  sock.emitMsg({ kind: "ask", messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "问", startedAt: 0 });
  expect(asks).toHaveLength(1);
  expect(asks[0].to).toBe("dev");
  mon.dispose();
});

test("injectReply 写入 socket", async () => {
  const sock = mockSocket() as any;
  const mon = new IntercomMonitor({
    onAsk: () => {}, onReply: () => {},
    connectFn: async () => sock,
  });
  await mon.connect();
  sock.writeBuf = "";
  await mon.injectReply("a1", "用户替答");
  expect(sock.writeBuf).toContain("a1");
  expect(sock.writeBuf).toContain("用户替答");
  mon.dispose();
});

test("getQueues 按 to 维度聚合", async () => {
  const sock = mockSocket() as any;
  const mon = new IntercomMonitor({
    onAsk: () => {}, onReply: () => {},
    connectFn: async () => sock,
  });
  await mon.connect();
  sock.emitMsg({ kind: "ask", messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "1", startedAt: 0 });
  sock.emitMsg({ kind: "ask", messageId: "a2", sessionId: "s1", from: "pm", to: "dev", text: "2", startedAt: 0 });
  const q = mon.getQueues();
  expect(q.get("dev")).toHaveLength(2);
  mon.dispose();
});

test("收 reply 后从队列移除", async () => {
  const sock = mockSocket() as any;
  const replies: [string, string][] = [];
  const mon = new IntercomMonitor({
    onAsk: () => {},
    onReply: (id, sid) => replies.push([id, sid]),
    connectFn: async () => sock,
  });
  await mon.connect();
  sock.emitMsg({ kind: "ask", messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "1", startedAt: 0 });
  sock.emitMsg({ kind: "reply", askMessageId: "a1", sessionId: "s1" });
  expect(replies).toEqual([["a1", "s1"]]);
  expect(mon.getQueues().get("dev")).toHaveLength(0);
  mon.dispose();
});
