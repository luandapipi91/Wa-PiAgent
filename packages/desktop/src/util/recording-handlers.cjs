// 录音前提：让 Chromium 自动批准 getDisplayMedia 并给系统回环音频（无共享框），
// 同时自动放行 media 权限（麦克风免弹窗）。确切回调参数以 spec A POC 为准。
// session / desktopCapturer 由调用方传入（解耦 Electron，便于单测注入）。
function setupRecordingHandlers(session, desktopCapturer) {
  session.setDisplayMediaRequestHandler(async (_req, cb) => {
    // 给系统回环音频；video 提供主屏 source 以满足 getDisplayMedia 协议（前端只取 audio track）
    let video = undefined;
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      if (sources.length > 0) video = sources[0];
    } catch { /* 取不到屏幕 source 也允许仅音频 */ }
    cb({ video, audio: "loopback" });
  });

  // 麦克风免弹窗：所有 media 权限请求一律放行
  session.setPermissionRequestHandler((_wc, _permission, cb) => cb(true));
  session.setPermissionCheckHandler(() => true);
}

module.exports = { setupRecordingHandlers };
