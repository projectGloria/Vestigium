@echo off
rem Vestigium command line: vestigium run --profile <site> [options]   (vestigium --help for all of them)
rem "--" goes first: Electron refuses to start when any argument follows a URL-like one (its CVE-2018-1000006
rem guard) unless "--" comes before them, and it keeps Chromium from reading our options as its own switches.
rem A .cmd waits for the program, so the run's exit code becomes this script's.
"%~dp0Vestigium.exe" -- %*
exit /b %ERRORLEVEL%
