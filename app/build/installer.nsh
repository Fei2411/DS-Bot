; Install for the current user only: the installer skips the page that asks
; "for all users or only for me" and never asks for administrator rights.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; The LANG_* symbols exist only after addLangs, which runs just before this
; hook; a LangString for a language the build does not load would create a
; phantom language table (makensis warning 6040, treated as error).
!macro customHeader
  !ifdef LANG_SIMPCHINESE
    LangString dsbInstDirNotWritable ${LANG_SIMPCHINESE} "无法写入「$dsbCheckTarget」。请换一个位置。"
  !endif
  !ifdef LANG_ENGLISH
    LangString dsbInstDirNotWritable ${LANG_ENGLISH} "Cannot write to $dsbCheckTarget. Choose another location."
  !endif
!macroend

; #626: the installer never asks for administrator rights, so a folder the user
; cannot write to only fails halfway through the install, with a misleading
; error. A content-less page between the directory page and the install checks
; that the chosen folder can be created and written to, and sends the user back
; to the directory page when it cannot.
!macro customPageAfterChangeDir
  !ifdef allowToChangeInstallationDirectory
    Var /GLOBAL dsbCheckTarget

    Page custom dsbCheckInstDir

    Function dsbCheckInstDir
      ${if} ${isUpdated}
        Abort
      ${endif}

      ; instFilesPre appends ${APP_FILENAME} to $INSTDIR only after this page,
      ; so the same rule is applied here on a copy and $INSTDIR stays untouched.
      ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
      ${if} $0 == ""
        StrCpy $dsbCheckTarget "$INSTDIR\${APP_FILENAME}"
      ${else}
        StrCpy $dsbCheckTarget $INSTDIR
      ${endif}

      ; $R1: the nearest ancestor that exists. Folders this check creates are
      ; removed again below, and only as far up as this ancestor.
      StrCpy $R1 $dsbCheckTarget
      ${Do}
        ${If} ${FileExists} "$R1"
          ${ExitDo}
        ${EndIf}
        ${StdUtils.GetParentPath} $R2 "$R1"
        ${If} $R2 == ""
        ${OrIf} $R2 == $R1
          ${ExitDo}
        ${EndIf}
        StrCpy $R1 $R2
      ${Loop}

      ; what the install does right after this: create the folder, write files
      StrCpy $R3 0
      ${IfNot} ${FileExists} "$dsbCheckTarget"
        ClearErrors
        CreateDirectory "$dsbCheckTarget"
        ${If} ${Errors}
          StrCpy $R3 1
        ${EndIf}
      ${EndIf}
      ${If} $R3 == 0
        ClearErrors
        GetTempFileName $R2 "$dsbCheckTarget"
        ${If} ${Errors}
        ${OrIf} $R2 == ""
          StrCpy $R3 1
        ${Else}
          ; updates replace files, so a folder must also allow deleting them
          ClearErrors
          Delete "$R2"
          ${If} ${Errors}
            StrCpy $R3 1
          ${EndIf}
        ${EndIf}
      ${EndIf}

      StrCpy $R4 $dsbCheckTarget
      ${DoWhile} $R4 != $R1
        RMDir "$R4"
        ${StdUtils.GetParentPath} $R2 "$R4"
        ${If} $R2 == ""
        ${OrIf} $R2 == $R4
          ${ExitDo}
        ${EndIf}
        StrCpy $R4 $R2
      ${Loop}

      ${If} $R3 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(dsbInstDirNotWritable)"
        SendMessage $HWNDPARENT 0x408 -1 0
      ${EndIf}
      Abort
    FunctionEnd
  !endif
!macroend
