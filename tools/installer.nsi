; Prism Cam installer (NSIS 3). Built by tools/release.sh:
;   makensis -DVERSION=1.0.0 -DSRC=<folder with prism-cam.exe> -DOUT=<Setup.exe> -DICON=<icon.ico> tools/installer.nsi
; Per-user install (no admin prompt) into %LOCALAPPDATA%\Programs\Prism Cam. The virtual camera itself is
; registered later from inside the app (one UAC prompt), into %ProgramFiles%\Prism Cam — a different folder.
; In-app updates run the new Setup.exe with /S /RELAUNCH: silent install, then Prism Cam starts again.
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APP "Prism Cam"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\PrismCam"

Name "${APP}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\Prism Cam"
InstallDirRegKey HKCU "Software\Prism Cam" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APP} ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=0 "ProductName" "${APP}"
VIAddVersionKey /LANG=0 "FileDescription" "${APP} installer"
VIAddVersionKey /LANG=0 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "LegalCopyright" "MIT License"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\prism-cam.exe"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Thai"

Section "Install"
  ; the files cannot be replaced while Prism Cam is open
  nsExec::Exec 'taskkill /F /IM prism-cam.exe'
  Sleep 600
  SetOutPath "$INSTDIR"
  File "${SRC}\prism-cam.exe"
  File "${SRC}\prism_vcam.dll"
  File "${SRC}\WebView2Loader.dll"
  File "${SRC}\prism.config.json"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\prism-cam.exe"
  IfSilent +2
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\prism-cam.exe"

  WriteRegStr HKCU "Software\Prism Cam" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "Prism"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\prism-cam.exe"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNKEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNKEY}" "EstimatedSize" $0
SectionEnd

Function .onInstSuccess
  ; started by the in-app updater → open Prism Cam again
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/RELAUNCH" $1
  IfErrors +2
  Exec '"$INSTDIR\prism-cam.exe"'
FunctionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM prism-cam.exe'
  Sleep 600
  Delete "$INSTDIR\prism-cam.exe"
  Delete "$INSTDIR\prism_vcam.dll"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\prism.config.json"
  Delete "$INSTDIR\*.old"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  DeleteRegKey HKCU "${UNKEY}"
  DeleteRegKey HKCU "Software\Prism Cam"
SectionEnd
