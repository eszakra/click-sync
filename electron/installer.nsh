; Custom NSIS Installer Script for ClickSync
; Sets the installer to a premium dark theme matching the app aesthetic

!macro customHeader
  ; Set Header Background and Text Colors
  ; NSIS uses BGR format (Blue, Green, Red)
  MUI_HEADER_TEXT_COLOR "FFFFFF"
  MUI_HEADER_SUBTEXT_COLOR "FF80CC" ; Light Magenta subtext
!macroend

!macro customWelcomePage
  ; Custom Welcome Page colors
  MUI_WELCOMEFINISHPAGE_INI_TEXT_COLOR "FFFFFF"
  MUI_WELCOMEFINISHPAGE_INI_BGCOLOR "000000"
!macroend

; Apply colors to the UI
!define MUI_BGCOLOR "000000"
!define MUI_TEXTCOLOR "F5F5F7"
!define MUI_BUTTONTEXTCOLOR "000000" ; Dark buttons on Windows default usually look better, but we are using a dark theme

; Specific overrides for the buttons and headers
!define MUI_FINI_BGCOLOR "000000"
!define MUI_FINI_TEXTCOLOR "FFFFFF"

; Custom strings to make it feel premium
VIAddVersionKey "ProductName" "ClickSync Studio"
VIAddVersionKey "CompanyName" "ClickSync"
VIAddVersionKey "LegalCopyright" "© 2025 ClickSync"
VIAddVersionKey "FileDescription" "AI-Powered Video Studio"

; Grant full permissions to installation directory after install
; This allows Remotion and other components to create cache folders
!macro customInstall
  ; Create .remotion folder preemptively
  CreateDirectory "$INSTDIR\.remotion"
  
  ; Use icacls to grant full control to Users group for the installation directory
  ; This fixes EPERM errors when Remotion tries to create .remotion folder in Program Files
  ; /grant gives permissions, (OI) = object inherit, (CI) = container inherit, F = full control
  ; /T applies recursively to existing files
  ; S-1-5-32-545 = Users group, S-1-5-11 = Authenticated Users
  nsExec::ExecToStack 'cmd /c icacls "$INSTDIR" /grant *S-1-5-32-545:(OI)(CI)F /T /Q'
  Pop $0
  Pop $1
  
  nsExec::ExecToStack 'cmd /c icacls "$INSTDIR" /grant *S-1-5-11:(OI)(CI)F /T /Q'
  Pop $0
  Pop $1
!macroend
