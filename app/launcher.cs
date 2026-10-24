using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// QQ 聊天机器人 · 独立版启动器
// 结构：本程序 = 窗口宿主（WebView2）+ 面板进程管理器 + 托盘图标
//   - 启动时隐藏拉起 node app\ui.mjs，等 127.0.0.1:3199 就绪
//   - 窗口用 WebView2 显示面板页面（和之前 Edge 里看到的一模一样）
//   - 点 × 不退出：按设置缩到托盘，或询问后处理
//   - 托盘点「退出」时才真的结束，可一并停掉机器人与网关
static class Program
{
    [STAThread]
    static void Main()
    {
        bool created;
        string mutexName = "Global\\qq-robot-talking-console-" + Hash(Root);
        using (Mutex mtx = new Mutex(true, mutexName, out created))
        {
            if (!created)
            {
                MessageBox.Show("控制面板已经在运行了。\n\n双击右下角托盘里的图标可以把它叫出来。",
                    "QQ 聊天机器人控制台", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    public static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    public static readonly string NodeExe = Path.Combine(Root, "node.exe");
    public static readonly string UiScript = Path.Combine(Root, "app", "ui.mjs");
    public static readonly string StateDir = Path.Combine(Root, "state");
    public static readonly string SettingsFile = Path.Combine(StateDir, "ui.json");
    public static readonly string LogFile = Path.Combine(StateDir, "launcher.log");
    public const string PanelUrl = "http://127.0.0.1:3199/";

    static string Hash(string s)
    {
        int h = 0;
        foreach (char c in s) h = (h * 31 + c) & 0x7fffffff;
        return h.ToString("x");
    }

    public static void Log(string msg)
    {
        try
        {
            Directory.CreateDirectory(StateDir);
            File.AppendAllText(LogFile, DateTime.Now.ToString("HH:mm:ss") + " " + msg + Environment.NewLine, Encoding.UTF8);
        }
        catch { }
    }
}

// 托盘 / 关窗 / 退出的设置，直接读写 state\ui.json（和面板是同一份文件）
static class Settings
{
    public static string CloseAction = "tray";      // tray | exit
    public static bool RememberClose = false;       // 勾过「记住我的选择」
    public static bool ExitStopsServices = true;    // 退出时是否连带停机器人与网关
    public static string Theme = "auto";            // auto | light | dark

    static Dictionary<string, object> Load()
    {
        try
        {
            if (!File.Exists(Program.SettingsFile)) return new Dictionary<string, object>();
            string text = File.ReadAllText(Program.SettingsFile, Encoding.UTF8);
            var ser = new JavaScriptSerializer();
            var d = ser.Deserialize<Dictionary<string, object>>(text);
            return d ?? new Dictionary<string, object>();
        }
        catch { return new Dictionary<string, object>(); }
    }

    public static void Read()
    {
        var d = Load();
        CloseAction = Str(d, "closeAction") == "exit" ? "exit" : "tray";
        RememberClose = Bool(d, "rememberClose");
        ExitStopsServices = !d.ContainsKey("exitStopsServices") || Bool(d, "exitStopsServices");
        string theme = Str(d, "theme");
        Theme = (theme == "dark" || theme == "light") ? theme : "auto";
    }

    public static void Write(bool remember, string closeAction, bool exitStops)
    {
        var d = Load();
        d["closeAction"] = closeAction;
        d["rememberClose"] = remember;
        d["exitStopsServices"] = exitStops;
        try
        {
            Directory.CreateDirectory(Program.StateDir);
            var ser = new JavaScriptSerializer();
            File.WriteAllText(Program.SettingsFile, ser.Serialize(d), Encoding.UTF8);
        }
        catch (Exception e) { Program.Log("写设置失败：" + e.Message); }
        CloseAction = closeAction; RememberClose = remember; ExitStopsServices = exitStops;
    }

    static string Str(Dictionary<string, object> d, string k)
    {
        object v;
        return d.TryGetValue(k, out v) && v != null ? v.ToString() : "";
    }

    static bool Bool(Dictionary<string, object> d, string k)
    {
        object v;
        if (!d.TryGetValue(k, out v) || v == null) return false;
        if (v is bool) return (bool)v;
        return v.ToString().Equals("true", StringComparison.OrdinalIgnoreCase);
    }
}

partial class MainForm : Form
{
    WebView2 web;
    NotifyIcon tray;
    Process panel;
    bool quitting = false;
    bool webReady = false;
    // 关窗询问正在处理中。用户手快连点两次 × 时，第二次 FormClosing 会再排一个
    // BeginInvoke，两个 CloseDialog 叠在一起；第一个选「缩到托盘」把窗口藏了之后，
    // 第二个的 ShowDialog(owner) 又强制把主窗口显示回来 —— 屏幕上就多出一个白窗，
    // 得再关一次才干净。这个标志让第二次点击直接吞掉。
    bool closeAsked = false;

    public MainForm()
    {
        Settings.Read();
        Text = "QQ 聊天机器人控制台";
        AutoScaleMode = AutoScaleMode.Dpi;
        // 按当前屏幕工作区定尺寸，避免在 4K / 150% 缩放下窗口过小或超出屏幕
        Rectangle wa = Screen.PrimaryScreen.WorkingArea;
        // 尽量占满工作区（留一点边），小屏幕上也不至于挤成一条
        Width = Math.Max(960, wa.Width - 36);
        Height = Math.Max(640, wa.Height - 36);
        StartPosition = FormStartPosition.Manual;
        Location = new Point(wa.Left + (wa.Width - Width) / 2, wa.Top + (wa.Height - Height) / 2);
        MinimumSize = new Size(900, 620);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        web = new WebView2();
        web.Dock = DockStyle.Fill;
        Controls.Add(web);

        Load += OnLoad;
        FormClosing += OnClosing;
        Resize += delegate { if (Visible && WindowState == FormWindowState.Minimized) HideToTray(false); };
        Shown += delegate
        {
            if (WindowState != FormWindowState.Normal) WindowState = FormWindowState.Normal;
            Show();
            Activate();
            Program.Log("窗口已显示：" + Width + "x" + Height + " @(" + Left + "," + Top + ") 屏幕 " + wa.Width + "x" + wa.Height);
        };

        BuildTray();
    }

    void BuildTray()
    {
        tray = new NotifyIcon();
        try { tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        catch { tray.Icon = SystemIcons.Application; }
        tray.Text = "QQ 聊天机器人控制台";
        tray.Visible = true;
        tray.DoubleClick += delegate { RestoreFromTray(); };

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开面板", null, delegate { RestoreFromTray(); });
        menu.Items.Add("重启机器人", null, delegate { RestartBot(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, delegate { AskExit(); });
        tray.ContextMenuStrip = menu;
    }

    async void OnLoad(object sender, EventArgs e)
    {
        Program.Log("窗口已打开");
        if (!File.Exists(Program.NodeExe))
        {
            MessageBox.Show("没有找到 node.exe，请把整个程序目录完整解压后再运行（不要单独拷 exe）。",
                "QQ 聊天机器人控制台", MessageBoxButtons.OK, MessageBoxIcon.Error);
            quitting = true; Close(); return;
        }
        if (!File.Exists(Program.UiScript))
        {
            MessageBox.Show("没有找到 app\\ui.mjs，程序目录不完整。",
                "QQ 聊天机器人控制台", MessageBoxButtons.OK, MessageBoxIcon.Error);
            quitting = true; Close(); return;
        }

        StartPanel();
        await InitWeb();
    }

    async System.Threading.Tasks.Task InitWeb()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.StateDir, "webview2"));
            await web.EnsureCoreWebView2Async(env);
            if (web.CoreWebView2 == null) { ShowFallback("WebView2 初始化失败：CoreWebView2 为空"); return; }
            webReady = true;
            web.CoreWebView2.NewWindowRequested += OnNewWindow;
            ApplyColorScheme();
            Program.Log("WebView2 就绪");
            WaitPanelThenNavigate(0);
        }
        catch (Exception ex)
        {
            Program.Log("WebView2 不可用：" + ex.Message);
            ShowFallback("这台机器没有装 WebView2 运行时，已改用系统浏览器打开面板。\n\n" +
                "装一次 Runtime 就能恢复内嵌窗口：\nhttps://developer.microsoft.com/microsoft-edge/webview2/");
        }
    }

    // WebView2 默认按浅色渲染，页面里的 prefers-color-scheme 就不会命中深色。
    // 这里读系统的「应用模式」设置，把它同步给 WebView2，夜间模式才会跟系统走。
    void ApplyColorScheme()
    {
        // 面板只保留深色一套配色（与 ui.html 的 :root 变量一致），
        // 不再读系统主题、也不读 state/ui.json 的 theme —— WebView2 的
        // PreferredColorScheme 只影响表单控件与滚动条，必须跟 CSS 对齐。
        try
        {
            web.CoreWebView2.Profile.PreferredColorScheme = CoreWebView2PreferredColorScheme.Dark;
            Program.Log("配色方案：深色（固定）");
        }
        catch (Exception ex) { Program.Log("设置配色失败：" + ex.Message); }
    }

    void ShowFallback(string msg)
    {
        Program.Log(msg);
        MessageBox.Show(msg, "QQ 聊天机器人控制台", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        try { Process.Start(Program.PanelUrl); } catch { }
    }

    void OnNewWindow(object sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        // 页面里的外链（比如 GitHub）交给系统浏览器
        e.Handled = true;
        try { Process.Start(e.Uri); } catch { }
    }

    void WaitPanelThenNavigate(int tries)
    {
        if (!PanelUp())
        {
            if (tries > 200) { ShowFallback("面板服务没有起来（127.0.0.1:3199），看 state\\ui.log。"); return; }
            var t = new System.Windows.Forms.Timer();
            t.Interval = 300;
            t.Tick += delegate
            {
                t.Stop(); t.Dispose();
                WaitPanelThenNavigate(tries + 1);
            };
            t.Start();
            return;
        }
        try
        {
            web.CoreWebView2.Navigate(Program.PanelUrl);
            Program.Log("面板已加载：" + Program.PanelUrl);
        }
        catch (Exception ex) { ShowFallback("打开面板失败：" + ex.Message); }
    }

    static bool PanelUp()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(Program.PanelUrl + "panel/api/ping");
            req.Timeout = 800;
            req.ReadWriteTimeout = 800;
            using (var resp = (HttpWebResponse)req.GetResponse()) { return (int)resp.StatusCode == 200; }
        }
        catch { return false; }
    }

    void StartPanel()
    {
        bool already = PortOpen(3199);
        if (already)
        {
            Program.Log("面板已经在跑（3199），直接复用。");
            return;
        }
        try
        {
            var psi = new ProcessStartInfo(Program.NodeExe, "app\\ui.mjs");
            psi.WorkingDirectory = Program.Root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            // 告诉面板：窗口由我这个 exe 提供，别再自己开一个浏览器窗口。
            psi.EnvironmentVariables["QQBOT_HOST"] = "webview";
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            panel = Process.Start(psi);
            panel.OutputDataReceived += delegate { };
            panel.ErrorDataReceived += delegate { };
            panel.BeginOutputReadLine();
            panel.BeginErrorReadLine();
            Program.Log("面板已启动（pid " + panel.Id + "，窗口由本程序提供）");
        }
        catch (Exception ex)
        {
            MessageBox.Show("启动面板失败：" + ex.Message, "QQ 聊天机器人控制台", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    static bool PortOpen(int port)
    {
        try
        {
            using (var c = new TcpClient())
            {
                var ar = c.BeginConnect(IPAddress.Loopback, port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(700)) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    // ---------- 托盘 ----------
    void HideToTray(bool saySomething)
    {
        // WebView2 的 composition 层不一定跟着 Form 一起藏，窗口看不见了
        // 屏幕上还会剩一块白底。先把它显式关掉，回来的时候再打开。
        if (web != null && web.Visible) web.Visible = false;
        Hide();
        ShowInTaskbar = false;
        if (saySomething && tray != null)
        {
            try { tray.ShowBalloonTip(1500, "还在后台运行", "双击托盘图标可以回到面板，右键菜单可以退出。", ToolTipIcon.Info); } catch { }
        }
    }

    void RestoreFromTray()
    {
        ShowInTaskbar = true;
        if (web != null && !web.Visible) web.Visible = true;
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
        BringToFront();
    }

    // ---------- 关窗 ----------
    void OnClosing(object sender, FormClosingEventArgs e)
    {
        Program.Log("OnClosing 进入：reason=" + e.CloseReason + " quitting=" + quitting + " visible=" + Visible);
        if (quitting) return;
        if (e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.TaskManagerClosing) return;

        e.Cancel = true;
        if (closeAsked) return;
        closeAsked = true;
        Program.Log("关窗请求：" + e.CloseReason);
        Settings.Read();
        Program.Log("当前设置 close=" + Settings.CloseAction + " remember=" + Settings.RememberClose + " exitStops=" + Settings.ExitStopsServices);

        if (Settings.RememberClose)
        {
            closeAsked = false;
            if (Settings.CloseAction == "exit") DoExit();
            else HideToTray(true);
            return;
        }

        // 在 FormClosing 里同步 ShowDialog 容易出问题，放到消息循环之后再弹
        BeginInvoke((Action)delegate
        {
            try
            {
                // 回到这里时窗口可能已经被别的路径藏起来了；这时再 ShowDialog(this)
                // 会强行把 owner 显示出来，等于又开一次白窗。
                if (quitting || !Visible) return;
                var dlg = new CloseDialog(Settings.CloseAction == "exit", Settings.ExitStopsServices);
                Program.Log("弹关窗对话框");
                dlg.ShowDialog(this);
                if (dlg.Cancelled) { Program.Log("关窗对话框：取消"); return; }
                Settings.Write(dlg.Remember, dlg.ChosenExit ? "exit" : "tray", dlg.ExitStops);
                Program.Log("关窗对话框：exit=" + dlg.ChosenExit + " remember=" + dlg.Remember);
                if (dlg.ChosenExit) DoExit();
                else HideToTray(true);
            }
            catch (Exception ex)
            {
                Program.Log("关窗处理异常：" + ex);
            }
            finally
            {
                closeAsked = false;
            }
        });
    }

    // ---------- 退出 ----------
    void AskExit()
    {
        Settings.Read();
        var dlg = new ExitDialog(Settings.ExitStopsServices);
        dlg.ShowDialog(this);
        if (dlg.Cancelled) return;
        Settings.Write(Settings.RememberClose, Settings.CloseAction, dlg.StopsServices);
        DoExit();
    }

    void DoExit()
    {
        quitting = true;
        Settings.Read();
        if (Settings.ExitStopsServices) StopServices();
        if (tray != null) { tray.Visible = false; tray.Dispose(); }
        FormClosing -= OnClosing;
        Close();
        Application.Exit();
    }

    void StopServices()
    {
        Program.Log("退出：按设置停止机器人与网关");
        HttpPost("/panel/api/bot/stop");
        HttpPost("/panel/api/snowluma/stop");
        try
        {
            if (panel != null && !panel.HasExited) panel.Kill();
        }
        catch { }
        // 面板自己可能拉过别的 node，兜底清一遍本目录的
        KillNodeByPath(Path.Combine(Program.Root, "app\\ui.mjs"));
        KillNodeByPath(Path.Combine(Program.Root, "src\\launch.mjs"));
        KillNodeByPath(Path.Combine(Program.Root, "src\\bridge.js"));
    }

    void KillNodeByPath(string marker)
    {
        try
        {
            var psi = new ProcessStartInfo("powershell",
                "-NoProfile -Command \"$m='" + marker.Replace("'", "''") + "'; " +
                "Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\" | " +
                "Where-Object { $_.CommandLine -like ('*' + $m + '*') } | " +
                "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            using (var p = Process.Start(psi)) { p.WaitForExit(4000); }
        }
        catch { }
    }

    void RestartBot()
    {
        HttpPost("/panel/api/bot/stop");
        ThreadPool.QueueUserWorkItem(delegate
        {
            Thread.Sleep(1500);
            HttpPost("/panel/api/bot/start");
            BeginInvoke((Action)delegate
            {
                if (tray != null) { try { tray.ShowBalloonTip(1500, "机器人已重启", "", ToolTipIcon.Info); } catch { } }
            });
        });
    }

    static void HttpPost(string path)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(Program.PanelUrl.TrimEnd('/') + path);
            req.Method = "POST";
            req.ContentType = "application/json";
            req.Timeout = 8000;
            byte[] body = Encoding.UTF8.GetBytes("{}");
            req.ContentLength = body.Length;
            using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
            using (var resp = (HttpWebResponse)req.GetResponse()) { }
        }
        catch (Exception e) { Program.Log("POST " + path + " 失败：" + e.Message); }
    }
}

// 关窗询问：缩到托盘 / 彻底退出 / 取消 + 记住选择
class CloseDialog : Form
{
    public bool Cancelled = true;
    public bool ChosenExit;
    public bool Remember;
    public bool ExitStops;

    public CloseDialog(bool defaultExit, bool exitStops)
    {
        Text = "关掉窗口？";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(430, 216);
        Font = new Font("Microsoft YaHei UI", 9f);
        ExitStops = exitStops;

        var tip = new Label();
        tip.Text = "关掉窗口后，机器人还要继续跑吗？";
        tip.SetBounds(18, 16, 396, 24);
        Controls.Add(tip);

        var rbTray = new RadioButton();
        rbTray.Text = "缩到托盘，继续在后台跑（推荐）";
        rbTray.SetBounds(24, 50, 380, 24);
        rbTray.Checked = !defaultExit;
        Controls.Add(rbTray);

        var rbExit = new RadioButton();
        rbExit.Text = "彻底退出，机器人和网关一起停";
        rbExit.SetBounds(24, 80, 380, 24);
        rbExit.Checked = defaultExit;
        Controls.Add(rbExit);

        var chk = new CheckBox();
        chk.Text = "记住我的选择，以后不再问";
        chk.SetBounds(24, 112, 380, 24);
        Controls.Add(chk);

        var ok = new Button();
        ok.Text = "确定";
        ok.SetBounds(226, 160, 88, 30);
        ok.Click += delegate
        {
            Cancelled = false;
            ChosenExit = rbExit.Checked;
            Remember = chk.Checked;
            DialogResult = DialogResult.OK;
            Close();
        };
        Controls.Add(ok);

        var cancel = new Button();
        cancel.Text = "取消";
        cancel.SetBounds(322, 160, 88, 30);
        cancel.Click += delegate { Cancelled = true; Close(); };
        Controls.Add(cancel);

        AcceptButton = ok;
        CancelButton = cancel;
    }
}

// 托盘退出询问：要不要一起停服务
class ExitDialog : Form
{
    public bool Cancelled = true;
    public bool StopsServices;

    public ExitDialog(bool defaultStops)
    {
        Text = "退出";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(430, 190);
        Font = new Font("Microsoft YaHei UI", 9f);
        StopsServices = defaultStops;

        var tip = new Label();
        tip.Text = "退出控制面板时，机器人和网关要一起停吗？";
        tip.SetBounds(18, 16, 396, 24);
        Controls.Add(tip);

        var rbStop = new RadioButton();
        rbStop.Text = "一起停（下次双击 exe 重新开始）";
        rbStop.SetBounds(24, 50, 380, 24);
        rbStop.Checked = defaultStops;
        Controls.Add(rbStop);

        var rbKeep = new RadioButton();
        rbKeep.Text = "只关面板，机器人继续在后台跑";
        rbKeep.SetBounds(24, 80, 380, 24);
        rbKeep.Checked = !defaultStops;
        Controls.Add(rbKeep);

        var ok = new Button();
        ok.Text = "退出";
        ok.SetBounds(226, 134, 88, 30);
        ok.Click += delegate
        {
            Cancelled = false;
            StopsServices = rbStop.Checked;
            DialogResult = DialogResult.OK;
            Close();
        };
        Controls.Add(ok);

        var cancel = new Button();
        cancel.Text = "取消";
        cancel.SetBounds(322, 134, 88, 30);
        cancel.Click += delegate { Cancelled = true; Close(); };
        Controls.Add(cancel);

        AcceptButton = ok;
        CancelButton = cancel;
    }
}
