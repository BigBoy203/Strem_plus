' Keeps the Stremio helper (scrape-helper.mjs: Torrent Stats + Download Ahead) running, with no window.
' Meant to be started at Windows login from the Startup folder ("Stremio Helper.lnk").
' If the helper crashes it is restarted after 5 s. If it exits cleanly (code 0, e.g. another copy
' is already running on port 48760), this script stops too.
Dim fso, shell, dir, code
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
' Lets all tracker DNS lookups run at once (Node's default is 4 at a time).
shell.Environment("Process")("UV_THREADPOOL_SIZE") = "32"
Do
  code = shell.Run("node scrape-helper.mjs", 0, True)
  If code = 0 Then Exit Do
  WScript.Sleep 5000
Loop
