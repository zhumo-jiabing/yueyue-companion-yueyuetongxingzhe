// [r225] 颜文字/抱抱库：语气的一部分，不是句末打卡。
// 老板 2026-11-28 反馈：P1/P6/P13/P16/P20 加上合适的颜文字和【抱抱】【摸摸】后，
// 观感明显软下来；软件里的颜文字太少，模型也不会恰当调用。
// 这里做三件事：
//   1) 给主程序一个比原来 10 张脸更大的确定性脸库（按情绪分组，轮换不连脸）；
//   2) 给「他疼/累/委屈/丧」的轮次一个可轮换的抱抱/摸摸标签（不写死一个词）；
//   3) 给提示词/测试一个共同的事实源，避免「提示词说有、代码里没有」。
// 硬线：颜文字是符号，不是声称真的碰到他；不解释符号；安全卡/risk>=3 不卖萌。
'use strict';

const GROUPS = {
    comfort: [
        '(つˆᴗˆ)つ',
        '⊂(・﹏・⊂)',
        '(´･ω･`)',
        '(｡•́︿•̀｡)',
        '(´；ω；`)',
        '(இ‸இﾟ)ﾟ',
        '(っ˘̩╭╮˘̩)っ',
        '( •̥́ ˍ •̀ू )',
        '(´,,•ω•,,)'
    ],
    happy: [
        '(*^▽^*)',
        '(￣▽￣)',
        '(￣▽￣)／',
        '(´｡• ᵕ •｡`)',
        'ヽ(・∀・)ﾉ',
        '(๑•̀ㅂ•́)و✧',
        '(￣︶￣)↗'
    ],
    shy: [
        '(⁄ ⁄•⁄ω⁄•⁄ ⁄)',
        '(*/ω＼*)',
        '(´,,•ω•,,)♡',
        '(´-ω-`)'
    ],
    sleepy: [
        '(´-ω-`)',
        '(－_－) zzZ',
        '(￣o￣) . z Z'
    ],
    confused: [
        '(・_・;)',
        '(￣▽￣;)',
        '(°ー°〃)',
        '(・ω・)'
    ],
    gentle: [
        '(´｡• ᵕ •｡`)',
        '( •̥́ ˍ •̀ू )',
        '(´,,•ω•,,)',
        '(・ω・)'
    ],
    proud: [
        '(￣︶￣)↗',
        '(•̀ᴗ•́)و',
        '(๑•̀ㅂ•́)و✧'
    ],
    neutral: [
        '(・ω・)',
        '(´･ω･`)',
        '(´-ω-`)'
    ]
};

// 兼容 main.js 原来的 FACES 结构：每个 mood 给一张最稳的默认脸。
// 真正挑选时用 pickFace()，会从对应组里按 seed 轮换。
const FACES = {
    happy: '(￣▽￣)',
    playful: '(￣▽￣)／',
    smug: '(￣︶￣)↗',
    sad: '(｡•́︿•̀｡)',
    concerned: '(´･ω･`)',
    shy: '(´-ω-`)',
    shy2: '(´･ω･`)',
    sleepy: '(´-ω-`)',
    confused: '(・ω・)',
    gentle: '(´｡• ᵕ •｡`)',
    proud: '(￣︶￣)↗',
    neutral: '(・ω・)'
};
const FACE_DEFAULT = '(´･ω･`)';

const FACE_LIST = Array.from(new Set([].concat(
    GROUPS.comfort, GROUPS.happy, GROUPS.shy, GROUPS.sleepy,
    GROUPS.confused, GROUPS.gentle, GROUPS.proud, GROUPS.neutral
)));

// 沉重轮不许出现的亮脸（含软笑）。main.js 的 M5/r185/r182 共用这张表。
const BRIGHT_FACES = [
    '(￣▽￣)／', '(￣▽￣)', '(￣︶￣)↗', '(｡•̀ᴗ-)✧',
    '(*^▽^*)', 'ヽ(・∀・)ﾉ', '(๑•̀ㅂ•́)و✧', '(´｡• ᵕ •｡`)'
];

// [r228] 沉重/安慰轮只许用「安慰脸」：不能让 (・_・;) / (-_-;) / (・ω・) 这类
// 尴尬/中性/困倦脸挂在「我心疼你」后面。老板真机反馈：文字很心疼，却发了
// (-_-;) —— 氛围一下破了。模型自己写的脸不在此库，另外用正则兜底。
const HEAVY_POOL = GROUPS.comfort.slice();
const HEAVY_FACE_RE = /\(-_-;?\)|\(・_・;\)|\(￣▽￣;\)|\(°ー°〃\)|\(；´д｀\)|\(=_=\)|\(T_T\)|\(;_;\)|\(´-ω-`\)|\(・ω・\)/g;

function sanitizeHeavyFaces(text, seed, avoid) {
    const rep = pickFace('concerned', seed || 0, { heavy: true, avoid: avoid || '' }) || FACE_DEFAULT;
    let out = String(text || '');
    out = out.replace(HEAVY_FACE_RE, rep);
    for (let i = 0; i < FACE_LIST.length; i++) {
        const f = FACE_LIST[i];
        if (HEAVY_POOL.indexOf(f) < 0 && out.indexOf(f) >= 0) out = out.split(f).join(rep);
    }
    return out;
}

// 抱抱/摸摸不是「动作表演」，是符号化的安慰；只在重情绪轮使用。
const TAGS = {
    // 带脸的版本让「标签 + 颜文字」一次到位；如果正文已有脸，改用 *Plain 版本，避免两张脸。
    comfort: [
        '【抱抱】(つˆᴗˆ)つ',
        '【抱一下】(つˆᴗˆ)つ',
        '【抱抱你】(つˆᴗˆ)つ',
        '【摸摸】(´･ω･`)',
        '【拍拍】(・ω・)',
        '【贴贴】⊂(・﹏・⊂)',
        '【递纸巾】⊂(・﹏・⊂)',
        '【陪你坐一会儿】( •̥́ ˍ •̀ू )'
    ],
    comfortPlain: [
        '【抱抱】',
        '【抱一下】',
        '【抱抱你】',
        '【摸摸】',
        '【拍拍】',
        '【贴贴】',
        '【递纸巾】',
        '【陪你坐一会儿】'
    ],
    happy: ['【嘿嘿(*^▽^*)】', '【开心】(´｡• ᵕ •｡`)', '【好耶】ヽ(・∀・)ﾉ', '【笑】(*^▽^*)'],
    happyPlain: ['【嘿嘿】', '【开心】', '【好耶】', '【笑】'],
    gentle: ['【小声】', '【嗯嗯】']
};

const COMFORT_TAG_RE = /【(?:抱抱|抱一下|抱抱你|摸摸|摸摸头|拍拍|拍一拍|贴贴|递纸巾|陪你坐一会儿)[^】]*】/;

function hash(s) {
    let h = 2166136261;
    s = String(s == null ? '' : s);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function pickFrom(list, seed, avoid) {
    if (!list || !list.length) return '';
    const a = String(avoid || '');
    const pool = list.filter(function (x) { return x && a.indexOf(x) < 0; });
    const use = pool.length ? pool : list;
    return use[hash(seed) % use.length];
}

const MOOD_GROUP = {
    happy: 'happy', playful: 'happy', smug: 'proud', proud: 'proud',
    sad: 'comfort', concerned: 'comfort', shy: 'shy', shy2: 'shy',
    sleepy: 'sleepy', confused: 'confused', gentle: 'gentle', neutral: 'neutral'
};

function pickFace(mood, seed, opts) {
    opts = opts || {};
    let group = GROUPS[MOOD_GROUP[mood] || mood] || GROUPS.neutral;
    if (opts.heavy) {
        // 沉重/安慰轮不按 mood 选：mood=confused 时会挑到 (・_・;) 这种尴尬脸。
        group = HEAVY_POOL;
    }
    return pickFrom(group, seed, opts.avoid);
}

function pickTag(group, seed, avoid, pool) {
    return pickFrom((pool && pool.length) ? pool : (TAGS[group] || TAGS.comfort), seed, avoid);
}

function hasFace(text) {
    const t = String(text || '');
    return FACE_LIST.some(function (f) { return t.indexOf(f) >= 0; });
}

function hasComfortTag(text) {
    return COMFORT_TAG_RE.test(String(text || ''));
}

module.exports = {
    GROUPS: GROUPS,
    FACES: FACES,
    FACE_LIST: FACE_LIST,
    FACE_DEFAULT: FACE_DEFAULT,
    BRIGHT_FACES: BRIGHT_FACES,
    HEAVY_POOL: HEAVY_POOL,
    HEAVY_FACE_RE: HEAVY_FACE_RE,
    sanitizeHeavyFaces: sanitizeHeavyFaces,
    TAGS: TAGS,
    COMFORT_TAG_RE: COMFORT_TAG_RE,
    hash: hash,
    pickFace: pickFace,
    pickTag: pickTag,
    hasFace: hasFace,
    hasComfortTag: hasComfortTag
};
