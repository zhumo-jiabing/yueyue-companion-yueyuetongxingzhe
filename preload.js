// 预加载脚本:通过 contextBridge 暴露最小化、安全的 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yueyue', {
    // 2026-09-10 公众测试版: 复制文本(诊断信息等)走主进程剪贴板, 更可靠
    copyText: (text) => ipcRenderer.invoke('app:copy-text', text),
    // 第99轮 A7-P1-6: 只读的本机信息(目前只有数据目录), 用于「关于玥玥」里显示真实路径
    info: {
        dataPath: () => ipcRenderer.invoke('app:data-path'),
        // 2026-11-17 第134轮 门槛2: 在文件管理器里打开真实数据目录
        openDataPath: () => ipcRenderer.invoke('app:open-data-path'),
        // 第134轮 M1: 用系统默认浏览器打开独立记忆读取器（本地离线 HTML）
        openMemoryReader: () => ipcRenderer.invoke('app:open-memory-reader'),
    },
    // 窗口控制
    openPet: () => ipcRenderer.send('open-pet'),
    // 2026-09-12 无边框主窗: 标题栏窗口按钮(最小化/最大化还原/关闭/查询状态)。
    // 主进程侧有 IPC 来源校验守卫(installIpcGuard), 这些通道只接受本应用窗口的调用。
    win: {
        minimize: () => ipcRenderer.invoke('win:minimize'),
        maximizeToggle: () => ipcRenderer.invoke('win:maximize-toggle'),
        close: () => ipcRenderer.invoke('win:close'),
        isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    },
    setPetHeight: (h) => ipcRenderer.invoke('pet:set-height', h),
    openChatWindow: () => ipcRenderer.send('open-chat-window'),
    closeChatWindow: () => ipcRenderer.send('close-chat-window'),
    closePet: () => ipcRenderer.send('close-pet'),
    openGame: () => ipcRenderer.send('open-game'),

    // 2026-11-22 第151轮 B 方案 §4.9: 激活向导要能打开「去哪注册」的页面。
    // 只认枚举键(deepseek/bigmodel) → 主进程侧映射成固定 URL, 不接受任意地址(防被诱导打开钓鱼站)。
    app: {
        openExternal: (target) => ipcRenderer.invoke('app:open-external', target),
    },

    // AI 对话(流式)
    ai: {
        chat: (payload) => ipcRenderer.invoke('ai:chat', payload),
        summarize: (payload) => ipcRenderer.invoke('ai:summarize', payload),
        complete: (payload) => ipcRenderer.invoke('ai:complete', payload),
        scene: (payload) => ipcRenderer.invoke('ai:scene', payload),
        search: (query, opts) => ipcRenderer.invoke('ai:web-search', { query, ...(opts || {}) }),
        video: (payload) => ipcRenderer.invoke('ai:video', payload),
        dualChat: (payload) => ipcRenderer.invoke('ai:dual-chat', payload),
        // 2026-11-17 第134轮 P1-2: 停止在途对话(主进程 abort 流式/回退请求)
        cancel: (id) => ipcRenderer.invoke('ai:cancel', id),
        // 2026-11-17 第134轮 P1-3: 体检用最小连通性探测(1 token, 不带对话)
        probe: (payload) => ipcRenderer.invoke('ai:probe', payload),
        onChunk: (fn) => ipcRenderer.on('ai:chunk', (event, data) => fn(data)),
        onDone: (fn) => ipcRenderer.on('ai:done', (event, data) => fn(data)),
        onError: (fn) => ipcRenderer.on('ai:error', (event, data) => fn(data)),
        onPhase: (fn) => ipcRenderer.on('ai:phase', (event, data) => fn(data)),
    },

    // 语音合成(本地 GPT-SoVITS API,主进程代理 + 显卡自适应配置)
    tts: {
        speak: (payload) => ipcRenderer.invoke('tts:speak', payload),
        getConfig: () => ipcRenderer.invoke('tts:get-config'),
        available: () => ipcRenderer.invoke('tts:available'),
        // 第101轮: 用户打开语音开关的瞬间就预热(拉起服务 + /warm 把模型搬进显存)。
        // 旧行为只在「启动时就已开着语音」的机器上预热, 启动后才开的人第一句仍要等 ~20 s 加载模型。
        prewarm: () => ipcRenderer.invoke('tts:prewarm'),
        // 2026-09-12: 打断/关语音时通知主进程取消服务端尚未开始的合成(否则白烧 CPU 并堵住新消息)
        cancel: () => ipcRenderer.invoke('tts:cancel'),
        onConfig: (fn) => ipcRenderer.on('tts:config', (event, cfg) => fn(cfg)),
    },

    // 环境感知(用户授权共享的前台窗口标题)
    env: {
        snapshot: () => ipcRenderer.invoke('env:snapshot'),
        uia: () => ipcRenderer.invoke('env:uia'),
        listWindows: () => ipcRenderer.invoke('env:list-windows'),
        watchWindow: (opts) => ipcRenderer.invoke('env:watch-window', opts),
    },
    // 沉浸陪看: 连续窗口画面捕捉已是 env.watchWindow; 这里放系统级事件
    sys: {
        onMemoryLow: (fn) => ipcRenderer.on('sys:memory-low', (event, data) => fn(data)),
        onMemoryOk: (fn) => ipcRenderer.on('sys:memory-ok', (event, data) => fn(data)),
    },

    // 语音转文字(本地 whisper, WAV 字节入参)
    stt: {
        transcribe: (wavBytes) => ipcRenderer.invoke('stt:transcribe', wavBytes),
        ready: () => ipcRenderer.invoke('stt:ready'),
    },
    // 情绪分类(本地 utilityProcess, 阶段3b; 失败返回 {label:null,reason} 不阻塞聊天)
    emotion: {
        classify: (payload) => ipcRenderer.invoke('emotion:classify', payload),
    },

    // 聊天小窗穿透锁定(防误触) + 主进程状态/语音启动事件
    chat: {
        setLock: (locked) => ipcRenderer.invoke('chat:set-lock', locked),
        setMouseThrough: (through) => ipcRenderer.invoke('chat:set-mouse-through', through),
        onLockState: (fn) => ipcRenderer.on('chat:lock-state', (event, v) => fn(v)),
        onVoiceStart: (fn) => ipcRenderer.on('chat:voice-start', () => fn()),
        // 2026-09-11: 主进程穿透看门狗解除穿透时通知渲染层重置缓存
        onUnthrough: (fn) => ipcRenderer.on('chat:unthrough', () => fn()),
        dragStart: (x, y) => ipcRenderer.send('chat:drag-start', x, y),
        dragMove: (x, y) => ipcRenderer.send('chat:drag-move', x, y),
        dragEnd: () => ipcRenderer.send('chat:drag-end'),
    },
    // 宠物 🎤 语音聊天入口(主进程打开聊天窗并触发录音)
    petVoiceChat: () => ipcRenderer.send('pet:voice-chat'),
    setPetMouseThrough: (through) => ipcRenderer.invoke('pet:set-mouse-through', through),
    onPetMoved: (fn) => ipcRenderer.on('pet:moved', () => fn()),
    // 2026-09-10 自绘拖动: 渲染层发增量位移(transparent 窗的 app-region:drag 在 Windows 下闪回左上角)
    movePetBy: (dx, dy) => ipcRenderer.send('pet:move-by', dx, dy),
    // 2026-09-11 拖动重做: 绝对光标锚点(替代增量, 修慢/顿/闪现/松手回弹)
    petDragStart: (x, y) => ipcRenderer.send('pet:drag-start', x, y),
    petDragMove: (x, y) => ipcRenderer.send('pet:drag-move', x, y),
    petDragEnd: () => ipcRenderer.send('pet:drag-end'),

    // 2026-09-12: 朗读期间按需关闭后台节流(读完立即恢复; 平时保持正常节流以省 CPU/内存)
    perf: {
        setBgThrottling: (on) => ipcRenderer.invoke('perf:set-bg-throttling', on),
        // 2026-09-12 第九轮: 计数器版本(多窗并发合成互相覆盖的修复)
        beginBgFullSpeed: () => ipcRenderer.invoke('perf:begin-bg-full-speed'),
        endBgFullSpeed: () => ipcRenderer.invoke('perf:end-bg-full-speed'),
    },

    // 成就状态持久化(主进程同步写文件, 强杀/崩溃也不丢)
    achStore: {
        save: (data) => ipcRenderer.invoke('ach:save', data),
        load: () => ipcRenderer.invoke('ach:load'),
    },

    // 设置(API Key 由主进程加密保存,渲染层只拿到脱敏信息)
    settings: {
        get: () => ipcRenderer.invoke('settings:get'),
        setKey: (key) => ipcRenderer.invoke('settings:set-key', key),
        clearKey: (provider) => ipcRenderer.invoke('settings:clear-key', provider),
        migrateKey: (key) => ipcRenderer.invoke('settings:migrate-key', key),
        // 2026-11-22 第153轮 P2-4: 自定义端点信任表(只回 host 名, 不含 Key)
        getEndpointTrust: () => ipcRenderer.invoke('settings:get-endpoint-trust'),
        setEndpointTrust: (host, trusted) => ipcRenderer.invoke('settings:set-endpoint-trust', host, trusted),
        // 2026-09-12 第九轮: 恢复出厂设置用(删 achievements.json 等本应用数据文件; 不含任意路径能力)
        clearAllData: () => ipcRenderer.invoke('settings:clear-all-data'),
    },

    // [r175] 关系阶段上限（只升不降）。渲染层的 localStorage 会被清，
    // 主进程 userData/relationship.json 不会 —— 清了缓存的用户不该一夜回到"刚认识"。
    stage: {
        getMax: () => ipcRenderer.invoke('stage:get-max'),
        setMax: (idx) => ipcRenderer.invoke('stage:set-max', idx),
    },

    // 人格包导出(2026-11-17 第134轮 门槛5): 走主进程「另存为」, 写盘成功后才回报成功
    soul: {
        save: (payload) => ipcRenderer.invoke('soul:save', payload),
    },

    // 插件（第44轮续三 · 模块 C）: 只暴露「看列表 / 开关一个」，没有安装/卸载/任意通道能力
    plugins: {
        list: () => ipcRenderer.invoke('plugins:list'),
        set: (id, enabled) => ipcRenderer.invoke('plugins:set', { id: String(id), enabled: !!enabled }),
    },
});
