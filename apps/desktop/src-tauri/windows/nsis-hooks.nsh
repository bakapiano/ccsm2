!macro NSIS_HOOK_POSTINSTALL
  ${If} $UpdateMode = 1
    Sleep 1500
  ${EndIf}
!macroend
