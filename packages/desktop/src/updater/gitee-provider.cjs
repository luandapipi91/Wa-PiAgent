// electron-updater 自定义 Provider：从 Gitee Releases 检查版本 + 解析下载地址。
// 继承 Provider 基类以获得 executor / isUseMultipleRangeRequest / fileExtraDownloadHeaders 等
// AppUpdater 可能访问的成员；实际请求用注入的 fetch（getLatestVersion）与 base 逻辑（resolveFiles）。
const { Provider, parseUpdateInfo } = require("electron-updater/out/providers/Provider");
const { buildGiteeApi, fetchText, findLatestYml } = require("./gitee-api.cjs");

class GiteeProvider extends Provider {
	constructor(options) {
		// options: { runtimeOptions: ProviderRuntimeOptions, baseUrl?, owner, repo, fetchImpl? }
		super(options.runtimeOptions);
		this.baseUrl = options.baseUrl || "https://gitee.com/api/v5";
		this.owner = options.owner;
		this.repo = options.repo;
		this.fetchImpl = options.fetchImpl || globalThis.fetch;
		this.api = buildGiteeApi({
			baseUrl: this.baseUrl,
			owner: this.owner,
			repo: this.repo,
			fetchImpl: this.fetchImpl,
		});
		this.fileUrls = new Map(); // 文件名 → browser_download_url
		this.releaseBody = "";
	}

	// electron-updater 要求：返回 UpdateInfo（version / files / releaseNotes 等）
	async getLatestVersion() {
		const release = await this.api.fetchLatestRelease();
		const attachFiles = await this.api.fetchAttachFiles(release.id);
		const latestYml = findLatestYml(attachFiles);
		if (!latestYml) {
			const e = new Error(`Cannot find latest.yml in the latest release artifacts (${release.htmlUrl})`);
			e.code = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
			throw e;
		}
		const rawData = await fetchText(this.api, latestYml.browserDownloadUrl);
		const channelFileUrl = new URL(latestYml.browserDownloadUrl);
		const updateInfo = parseUpdateInfo(rawData, "latest.yml", channelFileUrl);
		// 建立 文件名 → 下载 URL 映射（供 resolveFiles 使用）
		this.fileUrls = new Map(attachFiles.map((f) => [f.name, f.browserDownloadUrl]));
		this.releaseBody = release.body || "";
		// releaseNotes：优先用 Gitee Release body（UI 展示发行说明）
		if (!updateInfo.releaseNotes) updateInfo.releaseNotes = this.releaseBody;
		return updateInfo;
	}

	// electron-updater 要求：返回 ResolvedUpdateFileInfo[]（绝对下载 URL）
	resolveFiles(updateInfo) {
		const files = updateInfo.files || [];
		if (files.length === 0) {
			const e = new Error("Update info doesn't contain any files");
			e.code = "ERR_UPDATER_NO_FILES_PROVIDED";
			throw e;
		}
		return files.map((fileInfo) => {
			const url = this.fileUrls.get(fileInfo.url);
			if (!url) {
				const e = new Error(`Cannot find ${fileInfo.url} in the latest release artifacts`);
				e.code = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
				throw e;
			}
			return { url: new URL(url), info: fileInfo };
		});
	}
}

module.exports = { GiteeProvider };
