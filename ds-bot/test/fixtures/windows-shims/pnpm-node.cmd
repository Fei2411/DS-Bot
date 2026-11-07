@SETLOCAL
@IF NOT DEFINED NODE_PATH (
  @SET "NODE_PATH=C:\Users\<you>\AppData\Local\pnpm\global\5\node_modules"
) ELSE (
  @SET "NODE_PATH=C:\Users\<you>\AppData\Local\pnpm\global\5\node_modules;%NODE_PATH%"
)
@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\global\5\node_modules\opencode-ai\bin\opencode" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\global\5\node_modules\opencode-ai\bin\opencode" %*
)
