// 录音前提：让 Chromium 自动批准 getDisplayMedia 并给系统回环音频（无共享框），
// 同时自动放行 media 权限（麦克风免弹窗）。确切回调参数以 spec A POC 为准。
// session / desktopCapturer 由调用方传入（解耦 Electron，便于单测注入）。
function setupRecordingHandlers(session, desktopCapturer) {
  // 最小权限白名单：仅放行录音/录屏所需的 media 相关权限，其他一律拒绝
  const RECORDING_PERMISSIONS = ["media", "mediaKeySystem", "display-capture"];

  session.setDisplayMediaRequestHandler(async (_req, cb) => {
    // 给系统回环音频；video 提供主屏 source 以满足 getDisplayMedia 协议（前端只取 audio track）
    let video = undefined;
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      if (sources.length > 0) video = sources[0];
    } catch { /* 取不到屏幕 source 也允许仅音频 */ }
    cb({ video, audio: "loopback" });
  });

  // 麦克风免弹窗：仅放行白名单内的权限，其他权限请求一律拒绝（最小权限原则）
  session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(RECORDING_PERMISSIONS.includes(permission));
  });
  session.setPermissionCheckHandler((_wc, permission) => {
    return RECORDING_PERMISSIONS.includes(permission);
  });
}

module.exports = { setupRecordingHandlers };
