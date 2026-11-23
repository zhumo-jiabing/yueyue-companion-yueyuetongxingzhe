# Auto Live2D 桌宠包 (玥玥.exe)

解压本 ZIP, 把 runtime.html 放到玥玥.exe 的 resources/app/live2d/ 目录(与 live2d-pet.html 同层)。
runtime.html 自包含全部图层与配置: 透明背景、隐藏面板、自动待机动画(呼吸/眨眼/头部缓摆/眼神游移)。
宿主页面通过 BroadcastChannel('yueyue') 发送消息驱动表情与嘴型:
  {type:'auto-live2d:state', parameters:{ParamAngleY:6, ParamEyeLOpen:0.5, ParamMouthOpenY:0.4}}
参数 id 与编辑器一致(ParamAngleX/Y/Z 头部、ParamBodyAngleX/Z 身体、ParamEyeLOpen/ROpen 眼睛、ParamMouthOpenY 嘴、ParamEyeBallX/Y 眼球)。