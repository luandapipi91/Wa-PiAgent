/**
 * REST 路由注册器共享类型（阶段二·去 WS 化）
 *
 * 每个域一个文件（routes/<domain>.ts），导出 register 函数把该域的
 * REST 端点映射到原 WSClientEvent，经 callApi 适配器复用 handle() 业务逻辑。
 */
import type { WSClientEvent } from "@wa-pi/shared";
import type { HttpRouter } from "../http-router";
import type { ProjectStore } from "../project-store";

/** REST 适配器：见 WSServer.callApi 的语义注释 */
export type CallApiFn = (event: WSClientEvent, opts?: { responseTypes?: string[] }) => Promise<Response>;

export interface RouteContext {
  projectStore: ProjectStore;
  /** 可选：设置保存后重建活跃 pi 进程（如系统代理变更需重建进程继承新环境变量） */
  markAllDirty?: () => void;
}

export type RouteRegistrar = (router: HttpRouter, callApi: CallApiFn, ctx: RouteContext) => void;

/** 解析 JSON body；非法/空 body 返回 {}（保持与 WS 时代宽松语义一致） */
export async function readJsonBody(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}
