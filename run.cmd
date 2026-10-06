@echo off
REM Build if needed, then run. Any arguments are passed through to the server,
REM e.g.  run.cmd --osc-host 192.168.1.50 --osc-port 9000
setlocal
cd /d "%~dp0"
if not exist "build\solarsystem.jar" (
  echo Building...
  call mvn -q package || exit /b 1
)
java -jar build\solarsystem.jar %*
