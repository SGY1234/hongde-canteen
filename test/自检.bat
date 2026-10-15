@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "NODE=C:\Users\30205\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"
echo 正在自检（四组测试：契约 18 + 冒烟 35 + 二维码 13 + PNG 11）...
echo.
"%NODE%" test\frontend-contract.js
"%NODE%" test\smoke.js
"%NODE%" lib\qrcode-verify.js
"%NODE%" test\png-qr.js
pause
