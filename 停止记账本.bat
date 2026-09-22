@echo off
chcp 65001 >nul
title 停止记账本
cd /d "%~dp0"

echo.
echo   正在查找记账本服务...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ps=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.js*'});if($ps.Count -eq 0){exit 0};foreach($p in $ps){taskkill /F /PID $p.ProcessId|Out-Null};exit $ps.Count" >nul 2>nul

if errorlevel 1 goto stopped
goto notfound

:stopped
echo   已强制停止记账本服务。
echo.
echo   · 浏览器和手机现在都连不上了
echo   · 那个黑窗口会停在提示上，随便按个键就能关掉
echo   · 想再用，双击「启动记账本.bat」
echo.
echo   数据是安全的：每次改动都会很快写进 data\ledger.json，
echo   强制停止不会丢账目。
echo.
pause
exit /b 0

:notfound
echo   没有找到正在运行的记账本服务。
echo.
echo   可能它已经停了，或者你直接关掉那个黑窗口也一样。
echo.
pause
exit /b 0
