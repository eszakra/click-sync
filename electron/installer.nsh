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
