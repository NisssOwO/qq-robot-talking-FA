' 双击 start.bat / setup.bat 时用：把控制面板放到后台，不留下任何黑窗口。
' 面板自己的输出会写进 state\ui.log，界面「启动与状态 → 面板日志」里能直接看。
Dim fso, sh, root
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
sh.Run "node.exe app\ui.mjs", 0, False
