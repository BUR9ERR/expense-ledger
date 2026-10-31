@echo off
chcp 65001 >nul
title 记账本 - 检查并安装更新
cd /d "%~dp0"

rem Check GitHub for a newer version and install it.
rem Same as:  node tools\auto-update.js
rem Only check, never install:  append  --check
rem Never ask, always install:  append  --yes
rem See the README section on updating for scope and exclusions.
rem
rem NOTE: this file stays deliberately thin. cmd with chcp 65001 active can
rem mis-seek on long batch files and execute half a line, so all reporting
rem lives in tools\auto-update.js. Keep rem / :: lines ASCII-only and keep
rem the Chinese here to a minimum (the no-node message has to be Chinese,
rem because it has to work when node is missing).

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

"%NODE_EXE%" tools\auto-update.js %*
set "CODE=%ERRORLEVEL%"
echo.
pause
exit /b %CODE%

:nonode
echo.
echo   没有找到 Node.js，检查不了更新。
echo.
echo   请到 https://nodejs.org 下载安装（选 LTS 版本），装完再双击本文件。
echo   如果已经装了但还是这个提示，把 node.exe 的完整路径存成一个
echo   _node_path.txt 放在本文件旁边，再试一次。
echo.
pause
exit /b 1
