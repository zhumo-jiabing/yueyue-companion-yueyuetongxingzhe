// plugins/websearch/index.js —— 联网搜索插件（第44轮续三 · 模块 C 一期）
// 从 main.js 原样迁移：ipcMain.handle('ai:web-search', ...) 的整段逻辑，逐行保持行为一致。
// 变更点只有三处（都是"主进程能力"改走内核网关）：
//   net.fetch      → ctx.fetchJson(url, body, { key })   （权限 net:fetch，Authorization 由主进程拼）
//   keyForEndpoint → ctx.providerKey(endpoint, model)    （权限 key:provider）
//   DEFAULT_*      → ctx.defaults()
'use strict';

module.exports = {
    register(ctx) {
        const { model: DEFAULT_MODEL, apiUrl: DEFAULT_API_URL } = ctx.defaults();
        // 第87轮 B10: 不再写死官方域名 —— 用户的 Key 可能属于第三方代理/私有网关，
        // 写死 'https://api.deepseek.com/responses' 会把请求发到用户没有授权的域名（401 或隐私问题）。
        // 从用户配置的 apiUrl 推导：https://host/v1/chat/completions → https://host/v1/responses
        const responsesEndpoint = (u) => {
            try {
                const m = String(u || '').match(/^(https?:\/\/[^/?#]+)(\/[^?#]*)?/i);
                if (!m) return 'https://api.deepseek.com/responses';
                let base = (m[2] || '/chat/completions').replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
                if (!base) return m[1] + '/responses';
                return m[1] + base + '/responses';
            } catch (e) {
                return 'https://api.deepseek.com/responses';
            }
        };

        // 联网搜索(独立功能): 按当前模型对应的服务商路由搜索通道(2026-09 换装 GLM 后修复硬编码 401)
        ctx.handle('ai:web-search', async (event, payload) => {
            const query = (typeof payload === 'string') ? payload : String((payload && payload.query) || '');
            const model = (payload && payload.model) || DEFAULT_MODEL;
            const apiUrl = (payload && payload.apiUrl) || DEFAULT_API_URL;
            // 2026-09-14 第25轮修: 本条是"Key 槽不跟端点走"的第 6 条路径(此前只修了 ai:video)。
            // 本函数按 apiUrl 分派到 4 个服务商(智谱/阿里/DeepSeek/未知), 其中 DeepSeek 分支还打的是
            // **硬编码** 'https://api.deepseek.com/responses' —— 旧实现写死默认槽(智谱), 选 DeepSeek 必 401。
            // 故 Key 必须在 apiUrl/model 确定之后再选: 命中 deepseek(含硬编码分支) → deepseek 槽。
            // 2026-11-17 第129轮(老板 E1 拍板 · D1 最小档): DeepSeek 搜索改走 2026-11-13 新 API。
            // 旧实现是 legacy 工具 {type:'web_search'} + 强制 deepseek-v4-pro(第28轮口径)，
            // 只能拿到一段 output_text：没有 sources、没有 citations、拿不到 usage，也无法读链接。
            // 新口径(官方「全家桶」web_tools 文档)：
            //   模型固定 deepseek-flash；工具声明为 deepseek_web_search；
            //   **不能**与 legacy web_search 或其它服务端工具同时声明(400)；
            //   不声明 reasoning ⇒ 关思考搜索模式(kind=search)；深度搜索(deep_search)留给 E2 开关。
            // 本轮只声明 deepseek_web_search；deepseek_read_url 下一轮随 policy 条款一起上(E4)。
            const isDeepseekSearch = apiUrl.indexOf('deepseek') !== -1;
            const searchEndpoint = isDeepseekSearch ? responsesEndpoint(apiUrl) : apiUrl;
            const effectiveModel = isDeepseekSearch ? 'deepseek-flash' : model;
            const key = ctx.providerKey(searchEndpoint, effectiveModel);
            if (!key) return { ok: false, error: 'NO_KEY' };
            // postJson 语义与主进程旧实现完全相同：非 2xx 抛 Error(message)，否则返回 JSON
            const postJson = (url, body) => ctx.fetchJson(url, body, { key });
            // r188: 搜索与读链接共用 45 s 上限。ctx.fetchJson 自己没有超时参数，
            // 上游卡住会让整个对话停在"正在查"那里 —— 这里只是不等它，超时就当网络问题报回去。
            const withTimeout = (p, ms) => new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('HTTP 408 timeout after ' + ms + 'ms')), ms);
                Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); },
                    (e) => { clearTimeout(t); reject(e); });
            });
            // 从 OpenAI 兼容 chat/completions 响应中取正文
            const textOf = (data) => {
                const choice = data && data.choices && data.choices[0];
                const msg = choice && choice.message;
                return String((msg && msg.content) || '').trim();
            };
            try {
                if (apiUrl.indexOf('bigmodel.cn') !== -1) {
                    // 智谱: web_search 工具(OpenAI 兼容)
                    const data = await postJson(apiUrl, {
                        model,
                        messages: [{ role: 'user', content: query }],
                        tools: [{ type: 'web_search', web_search: { enable: true } }],
                    });
                    return { ok: true, text: textOf(data) };
                }
                if (apiUrl.indexOf('dashscope') !== -1 || apiUrl.indexOf('aliyuncs') !== -1) {
                    // 阿里百炼: 内置 enable_search
                    const data = await postJson(apiUrl, {
                        model,
                        messages: [{ role: 'user', content: query }],
                        enable_search: true,
                    });
                    return { ok: true, text: textOf(data) };
                }
                if (apiUrl.indexOf('deepseek') !== -1) {
                    // DeepSeek: Responses API + deepseek_web_search（2026-11-13 新工具；混用 legacy web_search 会 400）
                    // r188(S10): 最后一条用户消息里带 URL 时，一并声明 deepseek_read_url ——
                    // 官方口径：读链接只认最后一条用户消息里的 URL（去重、最多前 10 个），网页正文加密在
                    // signature 里、多轮必须原样回传；失败/无结果不计费。
                    const urlList = (String(query || '').match(/https?:\/\/[^\s，。；、）)"]+/gi) || [])
                        .map((u) => u.replace(/[.,;:!?]+$/, ''))
                        .filter((u, i, a) => a.indexOf(u) === i)
                        .slice(0, 10);
                    const tools = [{ type: 'deepseek_web_search' }];
                    if (urlList.length) tools.push({ type: 'deepseek_read_url' });
                    const data = await withTimeout(postJson(searchEndpoint, {
                        model: effectiveModel,
                        input: String(query || '').slice(0, 8000),
                        tools: tools,
                    }), 45000);
                    // 200 也可能带失败块：官方文档写明「生成失败仍回 HTTP 200，且已执行的搜索照常计费」
                    if (!data || data.error || data.status === 'failed') {
                        const e = (data && data.error) || {};
                        return { ok: false, error: 'SEARCH_UPSTREAM', code: String(e.code || e.type || 'UPSTREAM_FAILED'), message: String(e.message || '').slice(0, 200) };
                    }
                    // 正文：优先 Responses 的 output_text 快捷字段，否则自己从 message item 拼
                    let text = '';
                    if (typeof data.output_text === 'string') {
                        text = data.output_text;
                    } else if (Array.isArray(data.output)) {
                        text = data.output.filter((o) => o && o.type === 'message')
                            .map((o) => (o.content || []).map((c) => (c && c.text) || '').join(''))
                            .join('\n');
                    }
                    const items = Array.isArray(data.output) ? data.output : [];
                    // 工具调用块：web_search_call（真正检索到的来源在 action.sources 里）
                    const calls = items.filter((o) => o && /web_search_call|deep_search|read_url/i.test(String(o.type || '')));
                    const sources = [];
                    const seenUrl = new Set();
                    calls.forEach((c) => {
                        const list = (c.action && Array.isArray(c.action.sources)) ? c.action.sources : [];
                        list.forEach((s) => {
                            const url = String((s && s.url) || '').trim();
                            if (!url || seenUrl.has(url) || sources.length >= 4) return;
                            seenUrl.add(url);
                            sources.push({ url: url, title: String((s && s.title) || '').trim() });
                        });
                    });
                    // 引用角标：message item 的 content[].annotations（type=url_citation；title 可能为空串）
                    const citations = [];
                    items.forEach((o) => {
                        (Array.isArray(o && o.content) ? o.content : []).forEach((c) => {
                            (Array.isArray(c && c.annotations) ? c.annotations : []).forEach((a) => {
                                if (!a || a.type !== 'url_citation' || !a.url) return;
                                const url = String(a.url);
                                if (citations.some((x) => x.url === url)) return;
                                citations.push({ url: url, title: String(a.title || ''), start: a.start_index, end: a.end_index });
                            });
                        });
                    });
                    const readUrls = [];
                    calls.forEach((c) => {
                        if (!/read_url/i.test(String(c.type || ''))) return;
                        const u = String((c.action && (c.action.url || c.action.link)) || '').trim();
                        if (u && readUrls.indexOf(u) < 0 && readUrls.length < 10) readUrls.push(u);
                    });
                    return {
                        ok: true,
                        readUrls: readUrls,
                        text: String(text || '').trim(),
                        // 一个 web_search_call 都没有 = 响应到了但没真检索（诚实提示用，不能包装成「查到了」）
                        searched: calls.length > 0,
                        sources: sources,
                        citations: citations,
                        usage: (data && data.usage) ? data.usage : null,
                    };
                }
                // 未知服务商: 诚实降级——不带搜索工具地调用, 提示模型只答常识, 绝不 401
                const data = await postJson(apiUrl, {
                    model,
                    messages: [
                        { role: 'system', content: '你是联网搜索助手。当前搜索通道不可用，请只基于你的常识回答用户问题，不确定的地方明确说"这点我不太确定"。' },
                        { role: 'user', content: query },
                    ],
                });
                return { ok: true, text: textOf(data) };
            } catch (err) {
                // 第129轮(E1·D1): 失败不再只回一句人话，带上可判定的 code——
                // HTTP 码从 main.js:685-712 抛的 "HTTP 401"/"HTTP 429" 里抠出来，其余按网络错误。
                // 只用于诊断/降级文案，不打印 Key，也不进聊天上下文。
                const msg = String((err && err.message) || err || '');
                const m = msg.match(/HTTP\s+(\d{3})/i);
                return { ok: false, error: 'SEARCH_UPSTREAM', code: m ? ('HTTP_' + m[1]) : 'NETWORK', message: msg.slice(0, 200) };
            }
        });
    },
};
