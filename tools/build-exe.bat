@echo off
chcp 65001 >nul
title 记账本 - 打包单文件 exe
cd /d "%~dp0.."

rem Pack the whole app into dist\记账本.exe (Node SEA).
rem Build machine needs Node.js installed; the exe itself does not.
rem See README "打包成 exe" for usage and how to revert.

rem find node.exe - same order as 启动记账本.bat
set "NODE_EXE="
if not defined NODE_EXE if exist "%~dp0..\node\node.exe" set "NODE_EXE=%~dp0..\node\node.exe"
if not defined NODE_EXE for %%i in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE goto :nonode

rem npx.cmd sits next to node.exe; fall back to PATH
for %%d in ("%NODE_EXE%") do set "NODE_DIR=%%~dpd"
set "NPX=%NODE_DIR%npx.cmd"
if not exist "%NPX%" for %%i in (npx.cmd) do set "NPX=%%~$PATH:i"
if not exist "%NPX%" goto :nonpx

if not exist dist mkdir dist

echo.
echo [1/4] 生成打包入口 dist\sea-entry.js ...
"%NODE_EXE%" tools\build-exe.js || goto :fail

echo.
echo [2/4] 生成内嵌资源 blob ...
"%NODE_EXE%" --experimental-sea-config tools\sea-config.json || goto :fail

echo.
echo [3/4] 复制 Node 运行时作为外壳 ...
copy /y "%NODE_EXE%" "dist\记账本.exe" >nul || goto :fail

echo.
echo [4/4] 注入 blob，首次运行会联网下载 postject ...
call "%NPX%" --yes postject "dist\记账本.exe" NODE_SEA_BLOB "dist\ledger-sea.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 || goto :fail

echo.
echo   打包完成: dist\记账本.exe
echo.
pause
exit /b 0

:fail
echo.
echo   打包失败, 看上面的报错
echo.
pause
exit /b 1

:nonpx
echo.
echo   没找到 npx, 装 Node 时自带
echo.
pause
exit /b 1

:nonode
echo.
echo   没有找到 Node.js, 打包不了
echo   打包机要装 Node, 产物不需要
echo.
pause
exit /b 1
