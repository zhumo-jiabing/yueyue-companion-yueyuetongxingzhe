// plugin-host.js —— 玥玥插件微内核（第44轮续三 · 模块 C · 第44轮拍板 ①）
// -----------------------------------------------------------------------------
// 设计口径（用户 2026-10-20 拍板）：
//   · 内核是**纯增量**：已迁移的「游戏 / 联网搜索」默认开（保住现版本体验），
//     新插件（环境感知 / Minecraft mod）默认关。
//   · 回归闸门「全关插件 == 现版本行为」= 内核在没有任何插件启用时，
//     不注册任何 IPC 通道、不改任何既有路径；插件全关时进程照常起、照常聊。
//   · 内核只做四件事：生命周期+注册 / IPC 总线 / 存储网关 / 权限与安全。
//     内核要新增能力，必须先证明有 ≥3 个插件需要它（否则写进插件自己）。
//
// 诚实边界（不许含糊）：本内核是**进程内模块隔离**，不是安全沙箱。
// 插件文件随应用一起发布、是同可信级别的代码；manifest 里的 permissions 是
// **声明 + 内核侧强制校验**（未声明就用 → 抛错），用于约束"能力面"与防止误用，
// 不用于抵御恶意代码。真正的沙箱（utilityProcess + 独立权限令牌）不在本期范围。
// -----------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const REQUIRED_FIELDS = ['id', 'name', 'version', 'main', 'permissions', 'channels'];
// 允许插件 require 的模块白名单（够用即可，不开放 fs/net —— 要走 ctx 的网关）
const ALLOWED_REQUIRE = new Set(['path', 'node:path', 'crypto', 'node:crypto', 'util', 'node:util']);

function createPluginHost(opts) {
    opts = opts || {};
    const appRoot = opts.appRoot;
    const userDataPath = opts.userDataPath;
    const ipcMain = opts.ipcMain;
    const platform = opts.platform || {};
    const log = opts.log || ((m) => { try { console.log('[plugin] ' + m); } catch (e) { /* 忽略 */ } });

    const pluginsDir = path.join(appRoot, 'plugins');
    const statePath = path.join(userDataPath, 'plugin-state.json');
    const storeDir = path.join(userDataPath, 'plugin-store');

    const errors = [];          // [{id, message, at}]
    const registry = new Map(); // channel -> {id, kind:'handle'|'on'}
    const loadedIds = new Set();
    const metadatas = new Map(); // id -> manifest + dir（含被拒绝的目录，供 UI 说明）
    let state = { enabled: {} };

    function readState() {
        try {
            const raw = fs.readFileSync(statePath, 'utf8');
            const o = JSON.parse(raw);
            if (o && typeof o === 'object' && o.enabled && typeof o.enabled === 'object') return o;
        } catch (e) { /* 首次运行或坏文件 → 用默认 */ }
        return { enabled: {} };
    }
    function writeState() {
        try {
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        } catch (e) { log('state 写入失败: ' + (e && e.message)); }
    }
    state = readState();

    function setEnabled(id, on) {
        state.enabled[id] = !!on;
        writeState();
        // 立即生效：开 → 加载；关 → 卸载（不重启应用）
        if (on) loadOne(id); else unloadOne(id);
        return true;
    }

    function validateManifest(m, dir) {
        if (!m || typeof m !== 'object') return 'manifest.json 不是对象';
        for (const k of REQUIRED_FIELDS) if (!(k in m)) return 'manifest 缺字段: ' + k;
        if (!ID_RE.test(String(m.id))) return 'id 非法（只允许小写字母/数字/连字符，2-32 位）: ' + m.id;
        if (!Array.isArray(m.permissions)) return 'permissions 必须是数组';
        if (!Array.isArray(m.channels)) return 'channels 必须是数组';
        if (!Array.isArray(m.capabilities || [])) return 'capabilities 必须是数组';
        const mainPath = path.join(dir, m.main);
        if (!fs.existsSync(mainPath)) return 'main 文件不存在: ' + m.main;
        return null;
    }

    function scan() {
        const accepted = [];
        const rejected = [];
        let dirs = [];
        try { dirs = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
        catch (e) { return { accepted, rejected }; }
        for (const name of dirs.sort()) {
            const dir = path.join(pluginsDir, name);
            const mf = path.join(dir, 'manifest.json');
            if (!fs.existsSync(mf)) continue; // 空目录/杂物：静默跳过，不污染错误面
            let m = null;
            try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); }
            catch (e) { rejected.push({ dir: name, reason: 'manifest.json 解析失败: ' + (e && e.message) }); continue; }
            const bad = validateManifest(m, dir);
            if (bad) { rejected.push({ dir: name, reason: bad }); continue; }
            if (m.id !== name) { rejected.push({ dir: name, reason: '目录名与 manifest.id 不一致: ' + m.id }); continue; }
            metadatas.set(m.id, { manifest: m, dir });
            accepted.push(m.id);
        }
        return { accepted, rejected };
    }

    function isEnabled(id) {
        return loadedIds.has(id);
    }

    function enabledByConfig(id) {
        const m = metadatas.get(id);
        if (!m) return false;
        if (Object.prototype.hasOwnProperty.call(state.enabled, id)) return !!state.enabled[id];
        return m.manifest.defaultEnabled === true;
    }

    function recordError(id, err) {
        const message = (err && err.message) || String(err);
        errors.push({ id, message, at: Date.now() });
        log('插件 ' + id + ' 出错: ' + message);
    }

    function claimChannel(id, channel, kind) {
        if (registry.has(channel)) {
            const owner = registry.get(channel).id;
            throw new Error('通道已被插件 ' + owner + ' 占用: ' + channel);
        }
        if (kind === 'handle') ipcMain.handle(channel, wrapHandler(id, channel, kind));
        else ipcMain.on(channel, wrapHandler(id, channel, kind));
        registry.set(channel, { id, kind });
    }

    function wrapHandler(id, channel, kind) {
        return function (...args) {
            const ctx = activeCtx.get(id);
            if (!ctx) return kind === 'handle' ? { ok: false, error: '插件已停用' } : undefined;
            const meta = ctx._handlers.get(channel);
            const fn = meta && meta.fn;
            try {
                const r = fn.apply(null, args);
                if (r && typeof r.then === 'function') {
                    return r.catch((err) => {
                        recordError(id, err);
                        unloadOne(id);
                        return { ok: false, error: (err && err.message) || String(err) };
                    });
                }
                return r;
            } catch (err) {
                recordError(id, err);
                unloadOne(id);
                return kind === 'handle' ? { ok: false, error: (err && err.message) || String(err) } : undefined;
            }
        };
    }

    const activeCtx = new Map();

    function makeContext(m, dir) {
        const id = m.id;
        const perms = new Set(m.permissions || []);
        const channels = new Set(m.channels || []);
        const dataDir = path.join(storeDir);
        const storeFile = path.join(dataDir, id + '.json');
        let cache = null;
        function store() {
            if (cache) return cache;
            try { cache = JSON.parse(fs.readFileSync(storeFile, 'utf8')) || {}; } catch (e) { cache = {}; }
            return cache;
        }
        function flush() {
            try {
                fs.mkdirSync(dataDir, { recursive: true });
                fs.writeFileSync(storeFile, JSON.stringify(cache || {}, null, 2));
            } catch (e) { log('插件 ' + id + ' 存储写入失败: ' + (e && e.message)); }
        }
        function need(perm) {
            if (!perms.has(perm)) throw new Error('插件 ' + id + ' 未声明权限 ' + perm);
        }
        const handlers = new Map();

        const ctx = {
            id,
            name: m.name,
            version: m.version,
            manifest: m,
            _handlers: handlers,
            log: (msg) => log('[' + id + '] ' + String(msg)),
            has: (perm) => perms.has(perm),
            handle(channel, fn) {
                if (typeof fn !== 'function') throw new Error('handle 需要函数');
                if (!channels.has(channel)) throw new Error('通道未在 manifest.channels 声明: ' + channel);
                handlers.set(channel, { kind: 'handle', fn });
            },
            on(channel, fn) {
                if (typeof fn !== 'function') throw new Error('on 需要函数');
                if (!channels.has(channel)) throw new Error('通道未在 manifest.channels 声明: ' + channel);
                handlers.set(channel, { kind: 'on', fn });
            },
            // 存储网关（按插件命名空间）
            get: (k, dflt) => { const s = store(); return Object.prototype.hasOwnProperty.call(s, k) ? s[k] : dflt; },
            set: (k, v) => { const s = store(); s[k] = v; flush(); return v; },
            // 能力闸门（未声明即抛错）
            fetchJson: (url, body, extra) => { need('net:fetch'); return platform.fetchJson(url, body, extra); },
            providerKey: (endpoint, model) => { need('key:provider'); return platform.providerKey(endpoint, model); },
            defaults: () => platform.defaults,
            createWindow: (o) => { need('window:create'); return platform.createWindow(o); },
            registerWindow: (getter) => {
                need('window:create');
                if (typeof getter !== 'function') throw new Error('registerWindow 需要 getter 函数');
                secondaryWindows.set(id, getter);
            },
            notifications: (fn) => { // 插件可问"现在能不能发通知"（本期仅留接口，无人调用）
                if (typeof fn !== 'function') throw new Error('notifications 需要函数');
            },
        };
        return ctx;
    }

    // 内核给主进程用：插件申请的副窗口，内存看门狗/显隐循环要能找到它们
    const secondaryWindows = new Map();
    function allWindows() {
        const out = [];
        for (const [, getter] of secondaryWindows) {
            try { const w = getter(); if (w && !w.isDestroyed()) out.push(w); } catch (e) { /* 忽略 */ }
        }
        return out;
    }

    function loadOne(id) {
        if (loadedIds.has(id)) return true;
        const meta = metadatas.get(id);
        if (!meta) return false;
        const m = meta.manifest;
        const mainPath = path.join(meta.dir, m.main);
        try {
            const mod = { exports: {} };
            const sandbox = {
                module: mod,
                exports: mod.exports,
                console: { log: (x) => log('[' + id + '] ' + String(x)), warn: (x) => log('[' + id + ':warn] ' + String(x)), error: (x) => recordError(id, x) },
                require: (name) => {
                    if (!ALLOWED_REQUIRE.has(name)) throw new Error('插件不允许 require: ' + name);
                    return require(name);
                },
                __dirname: meta.dir,
                __filename: mainPath,
                setTimeout, clearTimeout, setInterval, clearInterval,
                JSON, Date, Math, Promise, String, Number, Boolean, Array, Object, Error, RegExp,
            };
            vm.createContext(sandbox);
            vm.runInContext(fs.readFileSync(mainPath, 'utf8'), sandbox, { filename: mainPath, timeout: 5000 });
            const plugin = mod.exports;
            if (!plugin || typeof plugin.register !== 'function') throw new Error('插件必须导出 register(ctx)');
            const ctx = makeContext(m, meta.dir);
            activeCtx.set(id, ctx);
            plugin.register(ctx);
            // register 里只登记了 handler 名，真正挂 IPC 放在这里（便于整批回滚）
            for (const [channel, meta] of ctx._handlers) claimChannel(id, channel, meta.kind);
            loadedIds.add(id);
            return true;
        } catch (err) {
            // 崩溃隔离：撤掉这个插件已经挂上的通道，其它插件继续跑
            for (const [channel, owner] of Array.from(registry)) {
                if (owner.id === id) {
                    try { owner.kind === 'handle' ? ipcMain.removeHandler(channel) : ipcMain.removeListener(channel); } catch (e) { /* 忽略 */ }
                    registry.delete(channel);
                }
            }
            activeCtx.delete(id);
            loadedIds.delete(id);
            secondaryWindows.delete(id);
            recordError(id, err);
            return false;
        }
    }

    function unloadOne(id) {
        for (const [channel, owner] of Array.from(registry)) {
            if (owner.id !== id) continue;
            try { owner.kind === 'handle' ? ipcMain.removeHandler(channel) : ipcMain.removeListener(channel); } catch (e) { /* 忽略 */ }
            registry.delete(channel);
        }
        activeCtx.delete(id);
        loadedIds.delete(id);
        secondaryWindows.delete(id);
        return true;
    }

    function loadAll() {
        const { accepted, rejected } = scan();
        const loaded = [];
        for (const id of accepted) {
            if (!enabledByConfig(id)) continue;
            if (loadOne(id)) loaded.push(id);
        }
        return { loaded, rejected, errors: errors.slice() };
    }

    // 给 UI 的只读视图
    function list() {
        const out = [];
        for (const [id, meta] of metadatas) {
            const m = meta.manifest;
            out.push({
                id,
                name: m.name,
                version: m.version,
                description: m.description || '',
                builtin: m.builtin === true,
                capabilities: m.capabilities || [],
                permissions: m.permissions || [],
                defaultEnabled: m.defaultEnabled === true,
                enabled: loadedIds.has(id),
                error: (errors.filter((e) => e.id === id).slice(-1)[0] || {}).message || null,
            });
        }
        return out.sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name) : (a.builtin ? -1 : 1)));
    }

    return {
        scan, loadAll, loadOne, unloadOne, setEnabled, isEnabled, enabledByConfig,
        state: () => JSON.parse(JSON.stringify(state)),
        errors: () => errors.slice(),
        list, allWindows,
        channels: () => Array.from(registry.keys()),
        _internals: { registry, activeCtx, metadatas, secondaryWindows },
    };
}

module.exports = { createPluginHost };
