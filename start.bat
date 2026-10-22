@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node.exe (
  echo [错误] 找不到 node.exe。请把 node.exe 放到本目录。
  pause
  exit /b 1
)
echo 正在打开控制面板……
node.exe app\ui.mjs
echo.
echo 面板已关闭。按任意键退出。
pause >nul
