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


};
