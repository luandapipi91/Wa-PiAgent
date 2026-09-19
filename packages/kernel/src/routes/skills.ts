/**
 * 技能域路由（阶段二·去 WS 化）
 */
import type { RouteContext, RouteRegistrar } from "./types";
import { readJsonBody, paramErrorResponse } from "./types";

export const registerSkillRoutes: RouteRegistrar = (r, callApi, ctx) => {
  r.add("GET", "/api/skills", async () => callApi({ type: "skill:list" }));

  r.add("POST", "/api/skills/toggle", async (req) => {
    const b = await readJsonBody(req);
    // REST 侧用 enabled 语义；WS 事件为 skillName/disabled（true=禁用），这里取反
    if (
      typeof b.name !== "string" ||
      !b.name ||
      typeof b.enabled !== "boolean"
    ) {
      return paramErrorResponse("缺少参数: name/enabled", "name/enabled");
    }
    return callApi({
      type: "skill:toggle",
      skillName: b.name,
      disabled: !b.enabled,
    });
  });

  r.add("POST", "/api/skills/dirs", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "skillDir:add", path: b.path });
  });

  r.add("DELETE", "/api/skills/dirs", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "skillDir:remove", path: b.path });
  });
};
