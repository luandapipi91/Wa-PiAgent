// 启动页 HTML 生成（纯函数，便于测试）。
// 端口自愈失败时，错误态显示「换端口启动」+「退出」按钮（替换原「重启应用」）。
const DEFAULT_CANVAS_BG = "#F5F5F7";
const DEFAULT_BRAND_GREEN = "#4BA26F";

/**
 * 生成启动页内联 HTML。
 * @param {Object} opts
 * @param {string} [opts.logoB64] - logo base64（空则用色块占位）
 * @param {string} [opts.canvasBg] - 页面背景色
 * @param {string} [opts.brandGreen] - 品牌绿
 * @returns {string} HTML 字符串
 */
function buildSplashHTML({
	logoB64 = "",
	canvasBg = DEFAULT_CANVAS_BG,
	brandGreen = DEFAULT_BRAND_GREEN,
} = {}) {
	const logoSrc = logoB64 ? `data:image/png;base64,${logoB64}` : "";
	return `<!doctype html><html lang="zh"><head><meta charset="utf-8"/><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{background:${canvasBg};display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#1d1d1f;user-select:none;overflow:hidden;-webkit-app-region:drag}
.logo{width:96px;height:96px;border-radius:22px;box-shadow:0 8px 24px rgba(0,0,0,.12);margin-bottom:24px}
.name{font-size:20px;font-weight:600;letter-spacing:.5px;margin-bottom:34px}
.bar{width:200px;height:4px;border-radius:99px;background:#e5e5ea;overflow:hidden}
.fill{height:100%;width:8%;border-radius:99px;background:${brandGreen};transition:width .45s cubic-bezier(.4,0,.2,1)}
.status{margin-top:16px;font-size:12px;color:#86868b;min-height:16px;text-align:center;padding:0 24px}
.err{color:#d9404d}
.btn{display:none;margin-top:12px;padding:8px 20px;border:0;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;-webkit-app-region:no-drag}
.btn:active{opacity:.85}
#switch-port-btn{background:${brandGreen};color:#fff}
#quit-btn{background:#e5e5ea;color:#1d1d1f}
</style></head><body>
${logoSrc ? `<img class="logo" src="${logoSrc}" alt="WA PI Agent"/>` : `<div class="logo" style="background:${brandGreen}"></div>`}
<div class="name">WA PI Agent</div>
<div class="bar"><div class="fill" id="fill"></div></div>
<div class="status" id="status">正在启动…</div>
<button id="switch-port-btn" class="btn" type="button">换端口启动</button>
<button id="quit-btn" class="btn" type="button">退出</button>
<script>
window.__setProgress=function(p,t){var f=document.getElementById('fill');if(f)f.style.width=Math.max(5,Math.min(100,p))+'%';var s=document.getElementById('status');if(s){if(t){s.textContent=t;s.className='status';}if(p<0){s.className='status err';}}};
window.__showActions=function(opts){var sb=document.getElementById('switch-port-btn'),qb=document.getElementById('quit-btn');if(sb)sb.style.display=opts&&opts.switchPort?'block':'none';if(qb)qb.style.display=opts&&opts.quit?'block':'none';};
document.getElementById('switch-port-btn').addEventListener('click',function(){this.disabled=true;this.textContent='正在切换…';if(window.waPiApp)window.waPiApp.switchPortStart();});
document.getElementById('quit-btn').addEventListener('click',function(){if(window.waPiApp)window.waPiApp.quit();});
</script>
</body></html>`;
}

module.exports = { buildSplashHTML };
