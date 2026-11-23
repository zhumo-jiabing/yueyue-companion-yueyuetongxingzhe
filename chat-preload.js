// =============================================================
// 按窗口拆分的最小 preload（2026-09-12 第九轮 · 审计 SEC-03）
// 背景：四窗原来共用一份 30+ 方法的 preload（含 settings.setKey / settings.clearAllData /
// env.watchWindow 等敏感能力）。任一窗页面被注入 = 拿到全部桥面。
// 现在每个窗口只拿到它真正用到的通道（用脚本实测各窗代码实际调用的方法得出）。
// 主进程侧的 IPC 来源校验（installIpcGuard）仍然保留，这是第二道闸。
// =============================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yueyue', {
    // 2026-09-12 第十二轮(修复第九轮 preload 拆分的回归): 聊天小窗也要发消息 ——
    // chat-engine.js 在模块加载期就调用 window.yueyue.ai.onChunk, 缺了它小窗直接 pageerror、无法发送。
    // 这里只补 chat-engine.js 实际用到的 7 个 ai 方法 + settings.migrateKey(实测列出), 不引入其它能力。
    ai: {
        chat: (payload) => ipcRenderer.invoke('ai:chat', payload),
        summarize: (payload) => ipcRenderer.invoke('ai:summarize', payload),
        complete: (payload) => ipcRenderer.invoke('ai:complete', payload),
        dualChat: (payload) => ipcRenderer.invoke('ai:dual-chat', payload),
        onChunk: (fn) => ipcRenderer.on('ai:chunk', (event, data) => fn(data)),
        onDone: (fn) => ipcRenderer.on('ai:done', (event, data) => fn(data)),
        onError: (fn) => ipcRenderer.on('ai:error', (event, data) => fn(data)),
    },
    settings: {
        migrateKey: (key) => ipcRenderer.invoke('settings:migrate-key', key),
    },
    // 聊天小窗穿透锁定 + 主进程状态/语音启动事件
    chat: {
        setLock: (locked) => ipcRenderer.invoke('chat:set-lock', locked),
        setMouseThrough: (through) => ipcRenderer.invoke('chat:set-mouse-through', through),
        onLockState: (fn) => ipcRenderer.on('chat:lock-state', (event, v) => fn(v)),
        onVoiceStart: (fn) => ipcRenderer.on('chat:voice-start', () => fn()),
        onUnthrough: (fn) => ipcRenderer.on('chat:unthrough', () => fn()),
        dragStart: (x, y) => ipcRenderer.send('chat:drag-start', x, y),
        dragMove: (x, y) => ipcRenderer.send('chat:drag-move', x, y),
        dragEnd: () => ipcRenderer.send('chat:drag-end'),
    },
    // 第97轮 P1-1: chat.html 的 voice-input.js:121 调 stt.transcribe, 原桥只有 ready → 语音输入必挂。
    // 与主窗 preload.js:61-63 同款桥接。
    stt: {
        ready: () => ipcRenderer.invoke('stt:ready'),
        transcribe: (wavBytes) => ipcRenderer.invoke('stt:transcribe', wavBytes),
    },
    closeChatWindow: () => ipcRenderer.send('close-chat-window'),
});
