// kernel 测试全局 setup（--preload 注入）：
// 包装 fetch，规避 Bun fetch 连接池同 host 多 server 场景错误复用连接的 bug。
//
// 现象：同一进程内多个测试先后创建 WSServer（127.0.0.1 不同端口）时，Bun fetch 的
// keep-alive 连接池会错误复用先前 server 的连接，导致后续请求被路由到错误的 server——
// SSE 连接注册进错误 sseBus（广播收不到）、POST 到错误 server（断言失败/回调不触发），
// 表现为「单独跑 pass、全量/串行跑 fail」且失败文件随机分布。
//
// 修复：对本地 server（127.0.0.1/localhost）请求默认加 connection: close，
// 禁用 keep-alive 连接复用，每个请求独立连接。
const origFetch = globalThis.fetch.bind(globalThis);

// bun 进程可能继承宿主桌面 kernel 的代理中继（HTTP_PROXY=127.0.0.1:<relay>，
// wa-pi 桌面 applySystemProxy 把 env 代理指向本地中继）。测试环境应直连：
// 清除代理 env（Bun 的代理变量是特殊 getter/setter，delete 清不掉，置空串才能清除）。
// 否则：fetch 走中继 → abort 不传播到服务端 req.signal、断网实验得到 502 而非 ECONNREFUSED。
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.http_proxy = "";
process.env.https_proxy = "";

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	try {
		const url =
			typeof input === "string"
				? new URL(input)
				: input instanceof URL
					? input
					: new URL(input.url);
		if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
			const headers = new Headers(init?.headers);
			headers.set("connection", "close");
			return origFetch(input, { ...init, headers });
		}
	} catch {
		// 非 URL 输入等异常：原样转发
	}
	return origFetch(input, init);
}) as typeof fetch;
