/**
 * HTTP 轻量路由表（阶段二·去 WS 化）
 *
 * 不引入框架：method + 路径模式（:param 段捕获）→ handler。
 * 无匹配返回 null，由调用方回退后续处理（静态文件 / 426）。
 */
export type RouteHandler = (
  req: Request,
  params: Record<string, string>,
) => Promise<Response> | Response;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export class HttpRouter {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): void {
    const segments = pattern.split("/").filter((s) => s.length > 0);
    this.routes.push({ method: method.toUpperCase(), segments, handler });
  }

  /** 匹配并执行；无匹配返回 null。handler 抛错转 500 {error}。 */
  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const pathSegs = url.pathname.split("/").filter((s) => s.length > 0);
    const method = req.method.toUpperCase();

    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== pathSegs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(":")) {
          params[seg.slice(1)] = decodeURIComponent(pathSegs[i]);
        } else if (seg !== pathSegs[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      try {
        return await route.handler(req, params);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }
    return null;
  }
}
