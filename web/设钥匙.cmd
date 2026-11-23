@echo off
chcp 65001 >nul
title 玥玥展台 · 写入 booth.key
cd /d "%~dp0"

echo.
echo ============================================
echo   把展台专用 Key 写进 booth.key
echo   粘贴时屏幕不回显，粘贴完按回车
echo ============================================
echo.
echo 先确认三件事（DeepSeek 平台 → API keys）：
echo   1) 新建一把「只用这一次」的钥匙，别用你平时那把
echo   2) 给它设一个额度上限（展台两天用量很小，几十块足够）
echo   3) 记下创建日期，展会后直接删掉这把
echo.
set /p YK=粘贴 Key 后按回车： 

if "%YK%"=="" (
  echo.
  echo [取消] 没有输入，什么都没写。
  pause >nul
  exit /b 1
)

> "booth.key" echo %YK%
set YK=

echo.
echo [完成] booth.key 已写入（本脚本不打印内容）。
echo        校验：另开窗口运行「启动展台.cmd」，看"模型钥匙"那行是不是「已加载」。
echo.
pause >nul
