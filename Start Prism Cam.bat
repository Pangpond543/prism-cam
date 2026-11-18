@echo off
cd /d "%~dp0"
rem Build output lives outside the project folder (keeps OneDrive / git clean)
set "CARGO_TARGET_DIR=%USERPROFILE%\PrismCamBuild\target"
set "BUILT=%CARGO_TARGET_DIR%\release\prism-cam.exe"
set "EXE=%BUILT%"
if exist "app\bin\prism-cam.exe" set "EXE=%~dp0app\bin\prism-cam.exe"
for /d %%D in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\BrechtSanders.WinLibs*") do set "PATH=%%D\mingw64\bin;%PATH%"
rem The UI (app\renderer) is embedded in the exe, so always build: cargo only recompiles when something changed.
where cargo >nul 2>nul
if errorlevel 1 (
  if exist "%EXE%" goto run
  echo Prism Cam needs Rust ^(rustup.rs^) and a C toolchain ^(MSVC Build Tools or WinLibs MinGW^).
  pause
  exit /b 1
)
if not exist "%BUILT%" echo Building Prism Cam - the first build takes a few minutes...
cargo build --release --workspace --manifest-path app\src-tauri\Cargo.toml
if errorlevel 1 (
  echo.
  echo Build failed. Prism Cam needs Rust ^(rustup.rs^) and a C toolchain ^(MSVC Build Tools or WinLibs MinGW^).
  if exist "%EXE%" ( echo Starting the previous build instead. & timeout /t 4 >nul & goto run )
  pause
  exit /b 1
)
rem app\bin holds the installed copy: refresh it with the build that was just made
if exist "app\bin\prism-cam.exe" (
  tasklist /fi "imagename eq prism-cam.exe" | find /i "prism-cam.exe" >nul && (
    echo Prism Cam is still open - close it, then run this again to start the new version.
    pause
    exit /b 1
  )
  copy /y "%BUILT%" "app\bin\prism-cam.exe" >nul
  if exist "%CARGO_TARGET_DIR%\release\prism_vcam.dll" copy /y "%CARGO_TARGET_DIR%\release\prism_vcam.dll" "app\bin\prism_vcam.dll" >nul 2>nul
)
:run
start "" "%EXE%"
