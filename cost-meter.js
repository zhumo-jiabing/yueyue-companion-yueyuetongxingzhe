// cost-meter.js — r221 P4: API 成本计量（只在本机计算与存储，绝不出网）
// 价格真源 = 同目录 pricing.json（2026-11-27 官方页实抓快照）。
// 设计约束：任何输入都不许抛异常（计量失败宁可返回 null，也不能影响对话主链）。
'use strict';
const fs = require('fs');
const path = require('path');

let _pricing = null;
let _pricingErr = null;
function loadPricing() {
    if (_pricing || _pricingErr) return _pricing;
    try {
        const raw = fs.readFileSync(path.join(__dirname, 'pricing.json'), 'utf8');
        const p = JSON.parse(raw);
        if (p && p.models && p.fx && typeof p.fx.usdToCny === 'number') _pricing = p;
        else _pricingErr = 'bad pricing.json shape';
    } catch (e) { _pricingErr = String((e && e.message) || e); }
    return _pricing;
}

// 只有 hostname 真是 *.deepseek.com 才算官方端点（代理/第三方即使路径含 deepseek 也不算，
// 避免给不认识 stream_options 的端点加字段导致 400）。
function isDeepseekHost(apiUrl) {
    try {
        const h = new URL(String(apiUrl || '')).hostname.toLowerCase();
        return h === 'deepseek.com' || h.endsWith('.deepseek.com');
    } catch (e) { return false; }
}

function modelKey(model, pricing) {
    const m = String(model || '').toLowerCase();
    if (!m) return null;
    if (pricing && pricing.aliases && pricing.aliases[m]) return pricing.aliases[m];
    if (m.indexOf('pro') !== -1) return 'deepseek-v4-pro';
    if (m.indexOf('flash') !== -1 || m === 'deepseek-chat') return 'deepseek-flash';
    return null; // glm/自定义模型等：无官方价，按 flash 估算并标「估」
}

function isPeakNow(pricing, now) {
    try {
        const d = now || new Date();
        const day = d.getUTCDay(); // 0=周日 6=周六
        if (day === 0 || day === 6) return false;
        const h = d.getUTCHours();
        const ranges = (pricing && pricing.peak && pricing.peak.hoursUTC) || [[1, 4], [6, 10]];
        for (let i = 0; i < ranges.length; i++) {
            if (h >= ranges[i][0] && h < ranges[i][1]) return true;
        }
        return false;
    } catch (e) { return false; }
}

// 中英混合粗估 ~0.6 token/字（只在拿不到 usage 时用，结果标 est）
function estimateTokensFromChars(chars) {
    const n = Number(chars);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.ceil(n * 0.6);
}

// 输入 {model, usage, apiUrl, promptChars, completionChars, kind}
// 输出 {cny, usd, est, model, pricedAs, peak, kind, source, tokens:{prompt,completion,cacheHit}} 或 null
// 缓存命中/未命中分开计价；est=true 表示 token 估算 / 未知模型 / 非官方端点，UI 标「估」。
function computeCost(input) {
    try {
        const pricing = loadPricing();
        if (!pricing) return null;
        const inp = input || {};
        const usage = (inp.usage && typeof inp.usage === 'object') ? inp.usage : null;
        const deepseek = isDeepseekHost(inp.apiUrl);
        let key = modelKey(inp.model, pricing);
        let est = false;
        let prompt = 0, completion = 0, hit = 0;
        let source = 'chars';
        // [r221 P4] 兼容两种 usage 格式：Chat Completions（prompt_tokens/completion_tokens/prompt_cache_hit_tokens）
        // 与 Responses（input_tokens/output_tokens/input_tokens_details.cached_tokens）——
        // websearch 插件走 Responses（plugins/websearch/index.js:153），只读前者会把搜索成本算成 0。
        const uPrompt = usage ? (Number(usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens) || 0) : 0;
        const uCompletion = usage ? (Number(usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens) || 0) : 0;
        const uHit = usage ? (Number(usage.prompt_cache_hit_tokens != null ? usage.prompt_cache_hit_tokens : (usage.input_tokens_details && usage.input_tokens_details.cached_tokens)) || 0) : 0;
        if (usage && (uPrompt > 0 || uCompletion > 0)) {
            prompt = Math.max(0, uPrompt);
            completion = Math.max(0, uCompletion);
            hit = Math.min(prompt, Math.max(0, uHit));
            source = 'usage';
            if (!deepseek || !key) { est = true; if (!key) key = 'deepseek-flash'; }
        } else {
            prompt = estimateTokensFromChars(inp.promptChars);
            completion = estimateTokensFromChars(inp.completionChars);
            hit = 0;
            est = true;
            if (!key) key = 'deepseek-flash';
        }
        const rates = pricing.models[key];
        if (!rates) return null;
        const peak = isPeakNow(pricing);
        const tier = peak ? 'peak' : 'offPeak';
        const miss = Math.max(0, prompt - hit);
        const usd = (hit * rates.cacheHit[tier] + miss * rates.cacheMiss[tier] + completion * rates.output[tier]) / 1e6;
        const cny = usd * pricing.fx.usdToCny;
        return {
            cny: Math.round(cny * 1e6) / 1e6,
            usd: Math.round(usd * 1e8) / 1e8,
            est: !!est,
            model: String(inp.model || key),
            pricedAs: key,
            peak: peak,
            kind: String(inp.kind || ''),
            source: source,
            tokens: { prompt: prompt, completion: completion, cacheHit: hit },
        };
    } catch (e) { return null; }
}

module.exports = { loadPricing, isDeepseekHost, modelKey, isPeakNow, computeCost };
