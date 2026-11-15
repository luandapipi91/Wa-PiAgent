; 升级链路加固（2026-11-15 事故）：覆盖安装时 WaPiKernel.exe 曾被旧内核进程锁死，
; nsis7z 覆盖写入失败被静默跳过 → 壳新核旧（壳 0.10.3 / 核 0.10.1 静默共存）。
; customInit 在 app-64.7z 解压前执行：显式 Delete 旧内核 exe（Electron 主 exe 同款
; 先删后释放套路）——未锁则删除成功，解压变为新建写入；仍被锁则 Delete 静默失败
;（NSIS Delete 语义），由应用侧启动自检（manifest 一致性校验弹窗）兑底发现。
!macro customInit
  Delete "$INSTDIR\resources\kernel\WaPiKernel.exe"
!macroend
