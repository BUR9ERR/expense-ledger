@echo off
chcp 65001 >nul
title 记账本 - 输入 q 回车停止服务
cd /d "%~dp0"

rem NOTE: keep every rem / :: line in this file ASCII-only. With chcp 65001
rem active, non-ASCII bytes inside a comment can make cmd mis-seek and execute
rem half a line. Chinese belongs in echo lines only.

set "NODE_EXE="

rem 1) portable Node bundled in .\node\node.exe
if not defined NODE_EXE if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"

rem 2) _node_path.txt next to this file: first line = full path of node.exe
rem    (not in git; escape hatch for "node installed but not on PATH")
if not defined NODE_EXE if exist "%~dp0_node_path.txt" for /f "usebackq delims=" %%p in ("%~dp0_node_path.txt") do if not defined NODE_EXE set "NODE_EXE=%%p"

rem 3) node.exe on the system PATH
if not defined NODE_EXE for %%i in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:i"

rem 4) common default install locations
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE goto nonode

rem auto-open the browser after start (2s delay so the port is ready;
rem  with a custom PORT this still opens 8765 - just edit the address bar)
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:8765/"

"%NODE_EXE%" server.js
goto ended

:nonode
echo.
echo   没有找到 Node.js，启动不了。
echo.
echo   请到 https://nodejs.org 下载安装（选 LTS 版本），装完再双击本文件。
echo   如果已经装了但还是这个提示，把 node.exe 的完整路径存成一个
echo   _node_path.txt 放在本文件旁边，再试一次。
echo.
pause
exit /b 1

:ended
echo.
echo   服务已停止，手机和浏览器都连不上了。
echo.
pause
