@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo.
echo 纸间 · 生成离线听书包
echo 正文会发送到在线 Edge TTS 服务生成自然声音。
echo 默认生成晓晓、晓伊两种女声和云希、云扬两种男声。
echo 生成后妈妈导入 .zjbook 即可在手机上选择这四种自然声音。
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 22.18 或更新版本。
  pause
  exit /b 1
)
where py >nul 2>nul
if errorlevel 1 (
  echo 未找到 Python。请先安装 Python 3，再重新运行。
  pause
  exit /b 1
)
py -c "from edge_tts.util import main" >nul 2>nul
if errorlevel 1 (
  echo 首次使用，正在安装免费的 edge-tts 工具……
  py -m pip install --user edge-tts
  if errorlevel 1 (
    echo 安装失败。请检查网络，或手动运行 py -m pip install --user edge-tts。
    pause
    exit /b 1
  )
)
py -c "from edge_tts.util import main" >nul 2>nul
if errorlevel 1 (
  echo 语音工具没有正确安装。请运行 py -m pip install --user --upgrade --force-reinstall edge-tts 后重试。
  pause
  exit /b 1
)
set /p "NOVEL=请把小说 .md、.txt 或 .docx 文件拖到这里，然后按回车："
set "NOVEL=%NOVEL:"=%"
if not exist "%NOVEL%" (
  echo 没有找到这个文件。
  pause
  exit /b 1
)
node scripts/make-zjbook.mjs --input "%NOVEL%"
if errorlevel 1 (
  echo 生成失败。请看上面的错误提示。
  pause
  exit /b 1
)
echo.
echo 完成。听书包和原文档放在同一个文件夹，请把 .zjbook 发给妈妈。
pause
