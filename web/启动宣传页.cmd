@echo off
title 玥玥 · 宣传页（本机预览）
cd /d "%~dp0"

set "PORT=8091"
set "DIR=%~dp0dist-static"

echo.
echo ============================================
echo   玥玥 · 宣传页 本机预览
echo   浏览器会自动打开；关掉这个黑窗口 = 停止
echo ============================================
echo.

if not exist "%DIR%\index.html" (
  echo [错误] 找不到 dist-static\index.html
  echo        先在这个目录里运行一次：python build-static.py
  echo.
  pause
  exit /b 1
)

rem ---- 找一个能用的 Python ----
set "PY="
set "BUNDLED=K:\yueyueneiceban\win-unpacked\GPT-SoVITS-0927-AMD\GPT-SoVITS-0927-zluda\runtime\python.exe"
if exist "%BUNDLED%" set "PY=%BUNDLED%"
if not defined PY (
  where python >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  where py >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
  echo [错误] 这台机器上没找到 Python。
  echo        换个办法：把 dist-static 文件夹直接拖到 https://app.netlify.com/drop 就能得到一个网址。
  echo.
  pause
  exit /b 1
)

rem ---- 2 秒后自动开浏览器（先开页面会白屏，所以要让服务先起来）----
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & explorer http://127.0.0.1:%PORT%/"

echo 服务已启动：http://127.0.0.1:%PORT%/
echo 如果浏览器没自动开，手动复制上面这个地址到地址栏。
echo.
echo （按 Ctrl+C 或直接关窗口就停止）
echo.

"%PY%" -m http.server %PORT% --directory "%DIR%"

echo.
echo 服务已停止。按任意键关闭。
pause >nul
