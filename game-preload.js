// =============================================================
// 按窗口拆分的最小 preload（2026-09-12 第九轮 · 审计 SEC-03）
// 背景：四窗原来共用一份 30+ 方法的 preload（含 settings.setKey / settings.clearAllData /
// env.watchWindow 等敏感能力）。任一窗页面被注入 = 拿到全部桥面。
// 现在每个窗口只拿到它真正用到的通道（用脚本实测各窗代码实际调用的方法得出）。
// 主进程侧的 IPC 来源校验（installIpcGuard）仍然保留，这是第二道闸。
// =============================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yueyue', {
    // 实测：game.js 只调用 window.yueyue.ai.complete（别无其它桥面）
    ai: {
        complete: (payload) => ipcRenderer.invoke('ai:complete', payload),
    },
});
