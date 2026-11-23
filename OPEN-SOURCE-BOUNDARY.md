# 开源边界清单 · AGPL + 核心闭源（open-core）

老板 m00672 拍板：「我同意AGPL + 核心闭源」。许可证=AGPL-3.0（见同目录 LICENSE）；本清单划 open/closed。
**本清单 govern  GitHub 公开导出，不 govern  shipped 内测安装包**（安装包仍含闭源核心，属内测分发，不贴 AGPL 标）。

## 闭源核心（proprietary，不进公开导出）
- `main.js`（思考脑/路由/安全红线逻辑/提示词矩阵 THINK_SYSTEM/buildMouthDirective）
- `chat-engine.js`（嘴脑/记忆白盒权重/画像/关系阶段注入）
- `index.js`（渲染层主逻辑/安全卡/记忆 UI）
- `soul.js`、`soul-pack.js`、`*.soul`（人格与人格包）
- `policy.html`（合规文案，受保护）
理由：核心含「危机绝不通知第三方」红线实现（与《暂行办法》第13条张力，最大规避风险不公开）+ 私密人格。
**结构性 caveat**：核心与引擎交织在上述 3 个大 js 内，故按文件粒度整文件闭源；公开的是外围引擎/管道/游戏/web/文档。若日后想开放更多脑部，需先把核心抽成独立闭源模块（refactor，另轮裁决），本轮不做。

## 开源（AGPL-3.0，进公开导出）
app 树除上述闭源清单外的其余文件，重点：
- `index.html`/`chat.html`/宠物窗/游戏窗 html、`preload.js`
- `tts-server.js`/`tts-voice.js`/`tts-config.js`/`stt/`（TTS 管道与脚本）
- `plugins/`（games/websearch）、`game.html`/`game.js`/`night.js`（游戏）
- `web/`（介绍页/静态包脚本）、`config.js`（模型端点/CONTACT，无 Key）
- `docs/architecture/`（12 图纸）、README/INDEX
随包义务：保留 LICENSE + 本清单 + 版权行；Apache-2.0 组件（Qwen3-TTS）附 LICENSE/NOTICE（补 G4）。

## 发布过滤（_dist\发布到GitHub 脚本消费）
导出 = app 树 open 集 + 本目录 LICENSE/本清单/README；**排除闭源清单 + 任何 Key/凭证/用户数据/记忆库**。发布前需老板 gh auth login + 明确 go；法律第13条仍阻塞「产品公开」，开源引擎公开≠产品公开。
