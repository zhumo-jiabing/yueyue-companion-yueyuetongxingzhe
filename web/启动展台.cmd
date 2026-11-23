@echo off
chcp 65001 >nul
title 玥玥展台 · 代理
cd /d "%~dp0"

echo.
echo ============================================
echo   玥玥展台 · 手机演示版
echo   关闭本窗口 = 展台停止服务
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 这台机器上没有 node，先装 Node.js 18 以上。
  pause
  exit /b 1
)

if not exist "booth.key" (
  echo [提醒] 没有找到 booth.key —— 如果也没有设置 YUEYUE_KEY，
  echo        启动后"模型钥匙"那行会显示 ❌，观众会看到"还没配好钥匙"。
  echo.
)

node proxy.cjs

echo.
echo 代理已退出。按任意键关闭窗口。
pause >nul
