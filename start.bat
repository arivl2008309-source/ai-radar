@echo off
chcp 65001 >nul 2>&1
title AI Radar 启动器
cd /d "%~dp0"

echo ========================================
echo   AI 雷达 (AI Radar v6) 启动中...
echo ========================================
echo.

REM 清理可能残留的旧代理进程（按命令行匹配 proxy.py）
for /f "tokens=2" %%P in ('wmic process where "commandline like '%%proxy.py%%' and not commandline like '%%wmic%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do (
    taskkill /F /PID %%P >nul 2>&1
)
timeout /t 1 >nul

REM 启动代理（默认端口 8787）
start "" /min python proxy.py 8787

REM 等待代理绑定端口
timeout /t 3 >nul

REM 打开浏览器
start "" http://localhost:8787/

echo.
echo  ✅ AI 雷达已启动
echo  🌐 访问地址: http://localhost:8787/
echo  ⏹  关闭此窗口不会停止服务；停止请结束 python proxy.py 进程
echo.
pause
