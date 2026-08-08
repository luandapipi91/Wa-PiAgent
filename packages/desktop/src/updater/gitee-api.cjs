// Gitee API v5 纯函数层：所有请求/解析逻辑与 electron-updater 解耦，fetch 由调用方注入（测试可 mock）。
// 仅依赖全局 fetch（Electron 主进程 / Node 18+ 均可用）。

function buildGiteeApi({ baseUrl, owner, repo, fetchImpl = globalThis.fetch }) {
	if (!fetchImpl) throw new Error("gitee-api: fetchImpl 不可用");

	const apiRoot = `${baseUrl.replace(/\/$/, "")}/repos/${owner}/${repo}`;

	async function fetchJson(url, label) {
		let res;
		try {
			res = await fetchImpl(url);
		} catch (e) {
			throw new Error(`${label}：网络请求失败（${e.message || e}）`);
		}
		if (!res.ok) {
			let detail = "";
			try { detail = (await res.text()).slice(0, 200); } catch {}
			if (res.status === 404) {
				throw new Error(`${label}：仓库暂无发行版（404）`);
			}
			if (res.status === 429) {
				throw new Error(`${label}：请求过于频繁（Gitee API 限流），请稍后再试`);
			}
			throw new Error(`${label}：HTTP ${res.status} ${detail}`);
		}
		return res.json();
	}

	/** GET /repos/{owner}/{repo}/releases/latest → { id, tagName, body, htmlUrl } */
	async function fetchLatestRelease() {
		const raw = await fetchJson(`${apiRoot}/releases/latest`, "检查更新");
		return {
			id: raw.id,
			tagName: raw.tag_name,
			body: raw.body ?? "",
			htmlUrl: raw.html_url,
		};
	}

	/** GET /repos/{owner}/{repo}/releases/{releaseId}/attach_files → [{ name, browserDownloadUrl, size }] */
	async function fetchAttachFiles(releaseId) {
		const list = await fetchJson(`${apiRoot}/releases/${releaseId}/attach_files`, "获取发行版附件");
		return (list || []).map((f) => ({
			name: f.name,
			browserDownloadUrl: f.browser_download_url,
			size: f.size,
		}));
	}

	// 同时暴露 fetchImpl，方便 fetchText 等外部辅助函数复用注入的 fetch
	return { fetchLatestRelease, fetchAttachFiles, fetchImpl };
}

/** 下载文本内容（用于 latest.yml / 安装包头校验），返回 string */
async function fetchText(api, url) {
	let res;
	try {
		res = api.fetchImpl ? await api.fetchImpl(url) : await globalThis.fetch(url);
	} catch (e) {
		throw new Error(`下载失败：${e.message || e}`);
	}
	if (!res.ok) {
		throw new Error(`下载失败：HTTP ${res.status}`);
	}
	return res.text();
}

/** 在附件列表中定位 latest.yml（Windows 通道文件），找不到返回 null */
function findLatestYml(files) {
	return files.find((f) => f.name === "latest.yml") || null;
}

module.exports = { buildGiteeApi, fetchText, findLatestYml };
