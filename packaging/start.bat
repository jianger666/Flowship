@echo off
rem fe-ai-flow first-run entry: double-click me.
rem Delegates to the silent vbs launcher; a desktop shortcut is created
rem automatically on first successful start -- use that afterwards.
wscript.exe "%~dp0launcher\launch.vbs"
