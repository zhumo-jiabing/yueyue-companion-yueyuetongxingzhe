// =============================================================
// 按窗口拆分的最小 preload（2026-09-12 第九轮 · 审计 SEC-03）
// 背景：四窗原来共用一份 30+ 方法的 preload（含 settings.setKey / settings.clearAllData /
// env.watchWindow 等敏感能力）。任一窗页面被注入 = 拿到全部桥面。
// 现在每个窗口只拿到它真正用到的通道（用脚本实测各窗代码实际调用的方法得出）。
// 主进程侧的 IPC 来源校验（installIpcGuard）仍然保留，这是第二道闸。
// =============================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yueyue', {
    ai: {
        video: (payload) => ipcRenderer.invoke('ai:video', payload),
    },
    // 环境感知（陪看/感知窗口）
    env: {
        listWindows: () => ipcRenderer.invoke('env:list-windows'),
        watchWindow: (opts) => ipcRenderer.invoke('env:watch-window', opts),
    },
    sys: {
        onMemoryLow: (fn) => ipcRenderer.on('sys:memory-low', (event, data) => fn(data)),
        onMemoryOk: (fn) => ipcRenderer.on('sys:memory-ok', (event, data) => fn(data)),
    },
    // 宠物窗自身：高度/穿透/拖动/语音入口/回调
    setPetHeight: (h) => ipcRenderer.invoke('pet:set-height', h),
    setPetMouseThrough: (through) => ipcRenderer.invoke('pet:set-mouse-through', through),
    onPetMoved: (fn) => ipcRenderer.on('pet:moved', () => fn()),
    petVoiceChat: () => ipcRenderer.send('pet:voice-chat'),
    petDragStart: (x, y) => ipcRenderer.send('pet:drag-start', x, y),
    petDragMove: (x, y) => ipcRenderer.send('pet:drag-move', x, y),
    petDragEnd: () => ipcRenderer.send('pet:drag-end'),
    openChatWindow: () => ipcRenderer.send('open-chat-window'),
    closePet: () => ipcRenderer.send('close-pet'),
});
