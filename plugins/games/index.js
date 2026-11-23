// plugins/games/index.js —— 小游戏插件（第44轮续三 · 模块 C 一期）
// 从 main.js 迁移：createGameWindow() 的窗口规格（尺寸/最小尺寸/不可缩放/preload/位置策略）
// 与 `ipcMain.on('open-game', createGameWindow)` 这条通道，现在由插件拥有。
// 窗口对象本身仍由主进程的 baseWindow() 造（插件没有也不该有 Electron 的直接引用），
// 走 ctx.createWindow(spec) + 权限 window:create。
'use strict';

// 窗口规格：与迁移前 main.js:createGameWindow 里的字面量逐项一致，改这里就等于改老代码
const GAME_WINDOW_SPEC = {
    name: 'game',
    file: 'game.html',
    preload: 'game-preload.js',
    width: 400,
    height: 560,
    minWidth: 360,
    minHeight: 500,
    resizable: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    anchor: 'right-of-main',   // 主窗右侧空白处；右侧放不下则放左侧
    onClosedEvent: 'game:closed',
};

module.exports = {
    register(ctx) {
        // 幂等开窗：已经开着就聚焦（老代码同语义：if (gameWindow) { show(); focus(); return; }）
        ctx.on('open-game', () => {
            ctx.createWindow(GAME_WINDOW_SPEC);
        });
    },
};
