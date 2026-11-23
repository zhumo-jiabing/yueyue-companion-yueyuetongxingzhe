// =============================================================
// 语音输出配置:本地 GPT-SoVITS API + 情绪参考音频库
// 服务由 GPT-SoVITS 目录下的 api_helpers/api_start.bat 启动
// =============================================================
window.TTS_CONFIG = {
    API_URL: 'http://127.0.0.1:9880',
    // 最终定版参数(16号配方 + FP32 服务端全精度 + 按标点切句)
    // r164: v4 那种「收窄随机度、平稳不跌宕起伏」把语气压成了冷淡。
    // 温度抬回来(情绪起伏)、语速再收一点、句间留长一点呼吸。
    PARAMS: {
        top_k: 8,
        top_p: 0.86,
        temperature: 0.92,
        speed_factor: 0.82,
        sample_steps: 6,
        text_split_method: 'cut5',
        fragment_interval: 0.5,
    },
    // 情绪 -> 参考音频(路径相对 GPT-SoVITS 安装目录)
    EMOTIONS: {
        '傲娇': {
            ref_audio_path: 'output/slicer_opt/260829024517_玥玥111.wav_0002062080_0002180480.wav',
            prompt_text: '是不是很气，嘿嘿气也没用。'
        },
        '关心': {
            ref_audio_path: 'output/slicer_opt/260830025102_就这个还可以.wav_0005028800_0005209280.wav',
            prompt_text: '今天也要好好吃饭，好好休息，别让我在沙河里还惦记你。'
        },
        '活泼': {
            ref_audio_path: 'output/slicer_opt/260829024517_玥玥111.wav_0000260480_0000439360.wav',
            prompt_text: '嘿嘿别小看我虽然我承认我刀工不怎么样。'
        },
        '日常': {
            ref_audio_path: 'output/slicer_opt/260829024517_玥玥111.wav_0000145920_0000257280.wav',
            prompt_text: '没干嘛，就窝在沙盒厨房里煮了点东西。'
        },
        '告别': {
            ref_audio_path: 'output/slicer_opt/260830025102_就这个还可以.wav_0005209280_0005432960.wav',
            prompt_text: '好了，那就先这样，我要去喂猫了，拜拜笨蛋主人，我晚点再来找你。'
        },
        '介绍': {
            ref_audio_path: 'output/slicer_opt/260829024517_玥玥111.wav_0000000000_0000145920.wav',
            prompt_text: '嗯，这里是月月，你问我刚才在干嘛？'
        },
    },
    // 应用情绪标签 -> TTS 情绪(覆盖 soul.js 里 MOOD 全部可选项)
    // v3: 安静/温柔类(gentle/quiet_company/night_watch/sad/关心)统一走"关心"参考音频(语速慢、音调低、体贴), 避免日常音频偏高的语气
    MOOD_MAP: {
        playful: '活泼',
        happy: '活泼',
        surprised: '活泼',
        morning_greet: '活泼',
        smug: '傲娇',
        concerned: '关心',
        sad: '关心',
        gentle: '关心',
        night_watch: '关心',
        quiet_company: '关心',
        waiting: '关心',
        serious: '日常',
        talking: '日常',
        shy: '日常',
        tea_time: '日常',
        thinking: '日常',
    },
    DEFAULT_EMOTION: '日常',
};
