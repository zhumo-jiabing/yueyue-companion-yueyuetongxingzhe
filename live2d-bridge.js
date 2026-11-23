// Live2D 桥接: 把情绪/说话状态发到桌宠运行时 (BroadcastChannel 'yueyue')
// 用法: 在 chat.html / index.html 引入本脚本, 然后调用 window.Live2dBridge.*
(function () {
    const CHANNEL_NAME = 'yueyue';
    let channel = null;
    function ensure() {
        if (!channel) {
            try { channel = new BroadcastChannel(CHANNEL_NAME); } catch (e) { channel = null; }
        }
        return channel;
    }
    function post(parameters) {
        const c = ensure();
        if (!c) return;
        c.postMessage({ type: 'auto-live2d:state', parameters: parameters });
    }
    // 情绪 -> 基础姿态(参数 id 与 AutoLive2d 编辑器一致, 数值为度/0..1)
    const MOOD_POSE = {
        happy:     { ParamAngleY: 6,  ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamMouthOpenY: 0.15 },
        sad:       { ParamAngleY: -7, ParamEyeLOpen: 0.55, ParamEyeROpen: 0.55, ParamAngleX: -4 },
        surprised: { ParamAngleY: 5,  ParamMouthOpenY: 0.4, ParamEyeLOpen: 1, ParamEyeROpen: 1 },
        playful:   { ParamAngleZ: 9,  ParamAngleX: 5 },
        serious:   { ParamAngleX: 2,  ParamAngleY: 1 },
        gentle:    { ParamAngleY: -2, ParamEyeLOpen: 0.85, ParamEyeROpen: 0.85 },
        concerned: { ParamAngleZ: -5, ParamAngleY: -3, ParamEyeLOpen: 0.7, ParamEyeROpen: 0.7 },
        talking:   { ParamMouthOpenY: 0.3 }
    };
    let speakTimer = null;
    let speakPhase = 0;
    window.Live2dBridge = {
        available: function () { return !!ensure(); },
        setMood: function (mood) {
            if (!mood) return;
            const pose = MOOD_POSE[mood] || MOOD_POSE.talking;
            post(pose);
        },
        // 说话时驱动嘴型(约 8Hz 波动), 结束恢复
        speakStart: function () {
            this.speakEnd();
            speakPhase = 0;
            speakTimer = setInterval(function () {
                speakPhase += 0.55;
                post({ ParamMouthOpenY: 0.3 + 0.3 * Math.abs(Math.sin(speakPhase)) });
            }, 120);
        },
        speakEnd: function () {
            if (speakTimer) { clearInterval(speakTimer); speakTimer = null; }
            post({ ParamMouthOpenY: 0 });
        }
    };
})();
