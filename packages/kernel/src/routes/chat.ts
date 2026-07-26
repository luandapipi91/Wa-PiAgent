/**
 * 对话控制域路由（阶段二·去 WS 化）
 */
import type { RouteContext, RouteRegistrar } from "./types";
import { readJsonBody } from "./types";

export const registerChatRoutes: RouteRegistrar = (r, callApi, ctx: RouteContext) => {
  r.add("POST", "/api/agents/:projectId/:sessionId/prompt", async (req, p) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "agent:prompt",
      projectId: p.projectId, sessionId: p.sessionId,
      agentName: b.agentName, text: b.text, model: b.model, thinking: b.thinking, attachments: b.attachments,
    }, { responseTypes: ["error"] });
  });

  r.add("POST", "/api/agents/:projectId/:sessionId/abort", async (req, p) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "agent:abort",
      projectId: p.projectId, sessionId: p.sessionId, agentName: b.agentName,
    });
  });

  // ask_user_question 应答 / 取消（直达 AskRegistry，幂等）
  r.add("POST", "/api/sessions/:sessionId/answer", async (req, p) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "agent:answer",
      sessionId: p.sessionId, toolCallId: b.toolCallId, reply: b.reply,
    });
  });
  r.add("POST", "/api/sessions/:sessionId/cancel-ask", async (req, p) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "agent:cancel-ask",
      sessionId: p.sessionId, toolCallId: b.toolCallId,
    });
  });

  // steer 队列控制：均为 fire-and-forget；失败由 case 内部 broadcast error
  r.add("POST", "/api/sessions/:sessionId/steer/promote", async (req, p) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "steer:promote",
      sessionId: p.sessionId, text: b.text, remainingTexts: b.remainingTexts,
    });
  });
  r.add("POST", "/api/sessions/:sessionId/steer/immediate", async (req, p) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "steer:immediate",
      sessionId: p.sessionId, text: b.text, remainingTexts: b.remainingTexts,
    });
  });
  r.add("POST", "/api/sessions/:sessionId/steer/cancel", async (_req, p) =>
    callApi({ type: "steer:cancel", sessionId: p.sessionId }));
  r.add("POST", "/api/sessions/:sessionId/steer/clear-queue", async (_req, p) =>
    callApi({ type: "steer:clear-queue", sessionId: p.sessionId }));
};
