@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title KineticSub Studio - Local Launcher (Port 3002)

cd /d "%~dp0"

echo ================================================================
echo   KineticSub Studio ^& English Reels - Khoi dong tren Port 3002
echo ================================================================
echo.

:: 1. Kiem tra Node.js & npm
where node >nul 2>&1
if errorlevel 1 (
  echo [LOI] Chua tim thay Node.js tren may.
  echo Vui long cai Node.js LTS tai: https://nodejs.org/
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER%

where npm >nul 2>&1
if errorlevel 1 (
  echo [LOI] Chua tim thay npm.
  pause
  exit /b 1
)

:: 2. Tai npm dependencies neu chua co hoac thieu
if not exist "node_modules" (
  echo.
  echo [1/4] Dang tai thu vien Node.js ^(npm install^)...
  call npm install
  if errorlevel 1 (
    echo [LOI] npm install that bai. Kiem tra ket noi mang hoac thu lai.
    pause
    exit /b 1
  )
) else (
  echo [OK] Thu vien node_modules da san sang.
)

:: 3. Tao file .env neu chua co
if not exist ".env" (
  if exist ".env.example" (
    copy ".env.example" ".env" >nul
    echo [OK] Da tao .env tu .env.example
  )
)

:: 4. Kiem tra FFmpeg (can cho render MP4 & ghep audio TTS)
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [CANH BAO] Chua thay FFmpeg trong PATH.
  echo   De render MP4 va ghep Audio TTS muot ma, hay cai FFmpeg:
  echo   winget install Gyan.FFmpeg
  echo.
) else (
  echo [OK] FFmpeg da san sang.
)

:: 5. Kiem tra Python & faster-whisper (tu dong cai neu da co Python ma chua co faster-whisper)
set PY_CMD=
where python >nul 2>&1
if not errorlevel 1 (
  set PY_CMD=python
) else (
  where py >nul 2>&1
  if not errorlevel 1 set PY_CMD=py -3
)

if defined PY_CMD (
  echo [2/4] Dang kiem tra Python faster-whisper...
  %PY_CMD% -c "import faster_whisper" >nul 2>&1
  if errorlevel 1 (
    echo [TAI] Chua thay goi faster-whisper. Dang cai dat qua pip...
    %PY_CMD% -m pip install --upgrade pip >nul 2>&1
    %PY_CMD% -m pip install faster-whisper
    if errorlevel 1 (
      echo [CANH BAO] Khong cai duoc Python faster-whisper.
      echo Server se tu dong dung Whisper ONNX Built-in ^(@huggingface/transformers^).
    ) else (
      echo [OK] Da cai dat faster-whisper thanh cong!
    )
  ) else (
    echo [OK] Python faster-whisper da san sang.
  )
) else (
  echo [THONG TIN] May chua cai Python - app se dung Whisper ONNX Built-in trong Node.js.
)

:: 6. Khoi chay server o Port 3002
echo.
echo [3/4] Dang khoi dong server tai http://localhost:3002 ...
echo       ^(Nhan Ctrl+C de dung server^)
echo.
set PORT=3002
set DISABLE_HMR=false

start "" "http://localhost:3002"
call npm run dev
if errorlevel 1 (
  echo.
  echo [LOI] Server bi dung dot ngot. Vui long xem thong bao loi phia tren.
  pause
  exit /b 1
)
