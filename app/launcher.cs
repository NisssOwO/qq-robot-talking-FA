// 双击入口：编译成「QQ聊天机器人.exe」。
// 它只做一件事——把同目录的 app\ui.mjs 用同目录的 node.exe 在后台拉起来，
// 然后自己退出。面板、网关、机器人都在 ui.mjs 里按配置启动。
// 所以这个 exe 只是「没有黑窗口的 start.bat」，逻辑仍然在 JS 里，方便改。
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string node = Path.Combine(root, "node.exe");
        string script = Path.Combine(root, "app", "ui.mjs");

        if (!File.Exists(node) || !File.Exists(script))
        {
            MessageBox.Show(
                "找不到 node.exe 或 app\\ui.mjs。\r\n\r\n"
                + "请把「QQ聊天机器人.exe」放在完整目录的最外层（和 node.exe、app 文件夹同级），"
                + "不要单独拷到别处。",
                "QQ 聊天机器人",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        try
        {
            ProcessStartInfo info = new ProcessStartInfo(node, "app\\ui.mjs");
            info.WorkingDirectory = root;
            info.UseShellExecute = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(info);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "启动失败：" + error.Message,
                "QQ 聊天机器人",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}
