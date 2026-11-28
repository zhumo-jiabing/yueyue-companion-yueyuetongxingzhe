// =============================================================
// 全局配置与功能扩展点
// =============================================================
// 商业化预留:未来接入订阅 / 增值功能时,在此扩展能力开关与定价层级,
// 例如 BILLING = { tiers: [...], features: {...} },当前全部功能免费开放。
window.APP_CONFIG = {
    // 2026-09-10 公众测试版标识(设置页「关于」显示)
    APP_VERSION: '0.3.0-beta.10',
    // 2026-11-23 r188: 宣传页「拿到这一份」下载段读这里。
    // url 留空 = 页面显示「内测版在群里发」，不会出现点不动的按钮。
    // 填了才渲染下载按钮 + 备用地址；sizeMB 只是给用户一个心理预期，不影响下载。
    DOWNLOAD: {
        url: '',
        mirror: '',
        sizeMB: 252,
        version: '0.3.0-beta.10',
        note: ''
    },
    BUILD_CHANNEL: '公众测试版',
    HOTLINE: '12356 全国心理援助热线（国家卫生健康委员会）/ 12355 青少年服务台（共青团中央）',
    // 历史: 2026-09-09 曾默认换装 GLM-5.3-Flash(付费档: 独立配额不挤免费限流; 1M 上下文; 原生多模态; 5折期输入0.4/输出1.4元每M)
    // 2026-10-20 第46轮(老板拍板): 默认换装 DeepSeek-V4.1-Flash —— flash 名下已是 v4.1 级部署(多模态/指令 JSON 66ms parse OK/吞吐 ~2000 tok/s, 价格约为 v4-pro 的 1/3; 见 main.js 双脑注释)。
    //   旧 GLM 档降级为备用但保留(不删除; 是否下线等下一轮拍板)。一次性迁移见 index.js migrateModelToV41(flag yueyue_model_mig_v41)。
    DEFAULT_API_URL: 'https://api.deepseek.com/chat/completions',
    // 2026-09-11 用户要求补齐用于"多模型交叉查漏"的档位(同一个智谱 Key 即可调用)
    // 实测(2026-09-11): glm-4.7 可用; glm-4.7-flash 返回 1305"当前访问量过大"(存在但常拥塞,故不作为默认备选);
    //                    glm-4.6v 可用且**支持图像输入**(是真正的视觉模型); glm-4.6v 与 glm-5.3-flash 都可看图。
    //                    glm-4.6 / glm-4.5 只接受 text(不接受 image_url)。
    // 2026-10-20 第46轮: 数组顺序 = 优先级, 第 1 条即默认档(chat-engine getModel 的兜底也是 MODELS[0]);
    //   旧档只加「旧」标注、不删除条目、不改各自 url —— 用户仍可手动选择, 是否下线等下一轮拍板。
    MODELS: [
        { value: 'deepseek-v4-flash', label: 'DeepSeek V4.1-Flash（付费 · 最新 · 推荐）', url: 'https://api.deepseek.com/chat/completions' },
        { value: 'deepseek-v4-pro', label: 'DeepSeek V4-Pro（旧代际 · 更慢 · 仅文本）', url: 'https://api.deepseek.com/chat/completions' },
        { value: 'glm-5.3-flash', label: 'GLM-5.3-Flash（旧 · 视觉/备用 · 独立配额不挤限流）', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
        { value: 'glm-4.7', label: 'GLM-4.7（旧 · 将逐步下线 · 情感/角色扮演向）', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
        { value: 'glm-4.6v', label: 'GLM-4.6V（旧 · 将逐步下线 · 能看图）', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
        { value: 'glm-4.6', label: 'GLM-4.6（旧 · 将逐步下线 · 对照用）', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
        { value: 'qwen3.8-flash', label: 'Qwen3.8-Flash（旧 · 将逐步下线 · 阿里）', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' },
    ],
    MAX_HISTORY: 20,
    // 第47轮: 记忆总量兜底池从 300 提到 800(其中永久/绝对核心永不淘汰; 超限按"最久没用"淘汰)。
    MAX_MEMORIES: 800,
    // 第47轮: 用户原话滚动保存上限(旧实现写死 800 条, 但同函数注释写「永不删除」——承诺与实现相反)。3000 条约 0.6 MB。
    MAX_RAW_MESSAGES: 3000,
    // 视频理解用的视觉模型(DeepSeek 官方多模态; 失败自动回落对话模型+诚实兜底)
    VISION_MODEL: 'deepseek-flash',
    // 2026-09-12 用户要求「多用 DeepSeek, 少用 GLM(GLM 耗 token 快)」: 截图审查默认改用 DeepSeek 官方视觉模型。
    // 历史: 2026-09-11 曾用 glm-4.6v(实测支持 image_url 且效果优于 glm-5.3-flash); 如 DeepSeek 视觉在具体图上
    // 表现不佳(该模型是 -exp, 曾有非零温度下空正文的情况, 调用方已用 temperature=0 + 重试兜底), 可临时改回 'glm-4.6v'。
    REVIEW_VISION_MODEL: 'deepseek-flash',
    // 深度共情模式:用户单条消息超过这些字数时,自动开启最强思考
    DEEP_THINK: { LONG_CHARS: 40, VERY_LONG_CHARS: 100 },
    // TODO(商业化):订阅等级与权益设计挂载点
    BILLING: null,
    // 对外联系方式(K2 两段式): 空串 = 阶段A; 填入值 = policy.html 渲染「联系渠道：<值>」+ 父页复制按钮
    // 第53轮(老板拍板): 填入对外联系方式 -> policy.html 自动从「阶段A(未公开)」切到「阶段B(显示联系方式)」,
    // 设置页「隐私政策与用户协议」打开后第十五节即可见; 安全卡「复制联系方式」也会复制这一行。
    CONTACT: 'QQ群 1002686604',
};
