@echo off
chcp 65001 >nul
title 记账本 - 输入 q 回车停止服务
cd /d "%~dp0"

set "NODE_EXE="

rem 1) 项目目录下自带的便携版 Node（把 node.exe 放进 node\ 子目录即可）
if not defined NODE_EXE if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"

rem 2) 同目录下的 _node_path.txt，第一行写着你本机 node.exe 的完整路径
rem    这个文件不进版本库，是给「node 不在 PATH 里」的人留的后门
if not defined NODE_EXE if exist "%~dp0_node_path.txt" for /f "usebackq delims=" %%p in ("%~dp0_node_path.txt") do if not defined NODE_EXE set "NODE_EXE=%%p"

rem 3) 系统 PATH 里的 node（正常安装 Node.js 后就会有）
if not defined NODE_EXE for %%i in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:i"

rem 4) 常见的默认安装位置
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE goto nonode

rem 服务起来后自动打开浏览器（延迟 2 秒等端口就绪；自定义过 PORT 的话
rem 这里打开的还是 8765，手动在地址栏改一下就行）
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
