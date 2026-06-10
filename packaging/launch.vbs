' fe-ai-flow silent launcher: runs launch.ps1 with a fully hidden window
' (a .lnk pointing at powershell.exe still flashes a console; wscript does not).
Dim fso, sh, scriptDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\launch.ps1""", 0, False
