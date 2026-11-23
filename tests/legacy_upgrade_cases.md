# 老用户升级回归用例

场景：用户已有昵称、已有聊天记录，但**没有年龄档**、**没有 P6 同意标记**（旧版本升级上来）。

## 必须发生
1. 启动后先出现年龄门（z-index 20000），其余界面 inert，键盘焦点落在中性标题，不落在任何一档按钮。
2. 选「成年」→ 二次确认 → 写入 `yueyue_age_band=adult`。
3. 关年龄门后，若仍未同意，出现 P6 同意门（z-index 15000）；未勾选时「同意并进入」不可用；点「不同意」只收起、不进入、不写标记。
4. 两次确认之间不出现引导页，也不出现主界面可交互状态。
5. 同意后进入主界面；首条回复使用 `yueyue_departure` 快照（若有），否则用通用问候。
6. 恢复出厂：逐会话清 IndexedDB/localStorage/websql/cachestorage/serviceworkers + clearCache + 子进程 shutdown → relaunch；重启后年龄门、同意门重新出现，紧急联系人、画像开关、风险日志全部清空。

## 不得发生
- 年龄门被同意门盖住顺序颠倒（同意门 z 低于年龄门，物理上不会盖住）。
- 未同意就能发消息。
- 恢复出厂后旧聊天/旧联系人残留。
- 诊断信息里出现紧急联系人（`copyDiagnostics` 不含 `yueyue_emergency_contact`）。

## 记录
每条断言写：页面 URL、关键元素 class/computedStyle、localStorage 关键键值、截图路径。
