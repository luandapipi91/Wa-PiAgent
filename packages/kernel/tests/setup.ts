// kernel 测试全局 setup（--preload 注入）：
//
// bun 进程可能继承宿主桌面 kernel 的代理中继（HTTP_PROXY=127.0.0.1:<relay>，
// wa-pi 桌面 applySystemProxy 把 env 代理指向本地中继）。测试环境应直连：
// 清除代理 env（Bun 的代理变量是特殊 getter/setter，delete 清不掉，置空串才能清除）。
// 否则：fetch 走中继 → abort 不传播到服务端 req.signal、断网实验得到 502 而非 ECONNREFUSED。
//
// 注：此前这里还包装 fetch 对本地请求强制 connection: close，规避 Bun fetch 连接池
// 同 host 多 server 错误复用连接的 bug；该 bug 已在 bun 1.4 修复（实测同 host 不同端口
// 正确路由），包装已移除。
process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.http_proxy = "";
process.env.https_proxy = "";
