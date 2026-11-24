; Custom steps for the Crystal Launcher installer (used by electron-builder's NSIS template)

!macro customHeader
  ; show the list of files being installed (like SKLauncher's installer) instead of hiding it
  ShowInstDetails show
  ShowUninstDetails show
  BrandingText "Crystal Launcher"
!macroend

!macro customInstall
  ; the desktop shortcut is optional: ask the user (silent installs default to Yes)
  MessageBox MB_YESNO|MB_ICONQUESTION "Create a desktop shortcut for Crystal Launcher?" /SD IDYES IDNO crystal_skip_desktop
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  crystal_skip_desktop:
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
!macroend
