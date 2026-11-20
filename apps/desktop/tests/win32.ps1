# 端到端测试用的 Windows 小工具，输出一行 JSON：
#   -Action state      -ProcessId N -Title 标题  某进程里这个标题的顶层窗口有几个、有没有看得见的
#   -Action close      -ProcessId N -Title 标题  给它的窗口发 WM_CLOSE（和点右上角 × 一样）
#   -Action client     -ProcessId N -Title 标题  把看得见的那个窗口切到前台，报它客户区左上角在屏幕上的位置（物理像素）；
#                      再给 -FromX -FromY -ToX -ToY 时，另报这两点露出来的是哪个进程的窗口
#   -Action tray-click -ProcessId N              给这个进程的托盘图标发一次“左键松开”（和人点托盘图标一样）
#   -Action drag       -FromX -FromY -ToX -ToY   用真的鼠标输入从一点拖到另一点（屏幕物理像素）
#   -Action drag ... -File 路径                  从屏幕上一个小窗口把这个文件拖到目标点（和从资源管理器拖文件一样）
#   -Action downloads                            当前用户的“下载”文件夹
# 标题由调用方传入（Windows PowerShell 5.1 按系统代码页读脚本，脚本里不写中文字面值）。
# 拖动会真的移动鼠标：跑端到端时别动这台电脑。
param(
    [ValidateSet('state', 'close', 'client', 'tray-click', 'drag', 'downloads')][string]$Action,
    [int]$ProcessId = 0,
    [string]$Title = '',
    [int]$FromX = 0, [int]$FromY = 0, [int]$ToX = 0, [int]$ToY = 0,
    [string]$File = ''
)
$ErrorActionPreference = 'Stop'
# 下面的 C# 里只写英文（按系统代码页读，中文注释可能读乱）：
#   DpiAware  按物理像素算坐标，不然缩放 150% 的屏幕上坐标会被换算
#   Drag      按下、分几步移过去、松开（先移过系统的拖动门槛，再慢慢过去让网页收到 dragover）
#   Front     把窗口切到前台（先按一下 Alt：系统只许刚有过输入的进程抢前台）
#   OwnerAt   屏幕上这一点露出来的是哪个进程的窗口
#   DragFile  在起点开一个小窗口，另一个线程在它上面按下鼠标，它收到按下后发起拖放（数据是这个文件），
#             那个线程再把鼠标移到终点松开；15 秒没拖起来就关掉小窗口
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
public static class ShellWindows {
    delegate bool EnumProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mouse; }
    const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;

    public static void DpiAware() { SetProcessDpiAwarenessContext(new IntPtr(-4)); }

    static List<IntPtr> Windows(uint pid, Func<IntPtr, bool> match) {
        var found = new List<IntPtr>();
        EnumWindows((window, data) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner == pid && match(window)) found.Add(window);
            return true;
        }, IntPtr.Zero);
        return found;
    }
    static string Text(IntPtr window, bool className) {
        var text = new StringBuilder(256);
        if (className) GetClassName(window, text, 256); else GetWindowText(window, text, 256);
        return text.ToString();
    }
    public static List<IntPtr> Find(uint pid, string title) { return Windows(pid, w => Text(w, false) == title); }
    public static List<IntPtr> TrayWindows(uint pid) { return Windows(pid, w => Text(w, true) == "tray_icon_app"); }
    public static Point ClientOrigin(IntPtr window) { var p = new Point(0, 0); ClientToScreen(window, ref p); return p; }
    public static bool Front(IntPtr window) {
        keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
        return SetForegroundWindow(window);
    }
    public static uint OwnerAt(int x, int y) {
        uint pid; GetWindowThreadProcessId(GetAncestor(WindowFromPoint(new Point(x, y)), 2), out pid); return pid;
    }

    static void Mouse(uint flags, int x, int y) {
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        var input = new INPUT { type = 0 };
        input.mouse.dx = (int)((x - vx) * 65535L / (vw - 1));
        input.mouse.dy = (int)((y - vy) * 65535L / (vh - 1));
        input.mouse.flags = flags | MOVE | ABSOLUTE | VIRTUALDESK;
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }
    public static void Drag(int fromX, int fromY, int toX, int toY) {
        Mouse(0, fromX, fromY); Thread.Sleep(100);
        Mouse(LEFTDOWN, fromX, fromY); Thread.Sleep(150);
        Glide(fromX, fromY, toX, toY);
        Mouse(LEFTUP, toX, toY);
    }
    static void Glide(int fromX, int fromY, int toX, int toY) {
        for (int i = 1; i <= 25; i++) {
            Mouse(0, fromX + (toX - fromX) * i / 25, fromY + (toY - fromY) * i / 25);
            Thread.Sleep(30);
        }
        Thread.Sleep(300);
    }
    public static string DragFile(string path, int fromX, int fromY, int toX, int toY) {
        string effect = "not-started";
        var form = new Form { FormBorderStyle = FormBorderStyle.None, StartPosition = FormStartPosition.Manual,
            Bounds = new Rectangle(fromX - 40, fromY - 40, 80, 80), TopMost = true, ShowInTaskbar = false };
        form.MouseDown += (sender, e) => {
            var data = new DataObject(DataFormats.FileDrop, new[] { path });
            effect = form.DoDragDrop(data, DragDropEffects.Copy | DragDropEffects.Move | DragDropEffects.Link).ToString();
            form.Close();
        };
        form.Shown += (sender, e) => {
            var mover = new Thread(() => {
                Thread.Sleep(300);
                Mouse(0, fromX, fromY); Thread.Sleep(100);
                Mouse(LEFTDOWN, fromX, fromY); Thread.Sleep(400);
                Glide(fromX, fromY, toX, toY);
                Mouse(LEFTUP, toX, toY);
            });
            mover.IsBackground = true;
            mover.Start();
        };
        var giveUp = new System.Windows.Forms.Timer { Interval = 15000 };
        giveUp.Tick += (sender, e) => form.Close();
        giveUp.Start();
        Application.Run(form);
        return effect;
    }
}
'@
[ShellWindows]::DpiAware()

switch ($Action) {
    'state' {
        $windows = [ShellWindows]::Find($ProcessId, $Title)
        $visible = @($windows | Where-Object { [ShellWindows]::IsWindowVisible($_) }).Count
        @{ count = $windows.Count; visible = $visible } | ConvertTo-Json -Compress
    }
    'close' {
        $windows = [ShellWindows]::Find($ProcessId, $Title)
        foreach ($window in $windows) { [ShellWindows]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
        @{ closed = $windows.Count } | ConvertTo-Json -Compress
    }
    'client' {
        # 先切到前台，再报客户区左上角，以及起点、终点（-FromX/-ToX 等，给了的话）露出来的是哪个进程的窗口
        $window = [ShellWindows]::Find($ProcessId, $Title) | Where-Object { [ShellWindows]::IsWindowVisible($_) } | Select-Object -First 1
        $front = [ShellWindows]::Front($window)
        Start-Sleep -Milliseconds 300
        $origin = [ShellWindows]::ClientOrigin($window)
        @{ x = $origin.X; y = $origin.Y; front = $front; fromOwner = [ShellWindows]::OwnerAt($FromX, $FromY); toOwner = [ShellWindows]::OwnerAt($ToX, $ToY) } | ConvertTo-Json -Compress
    }
    'tray-click' {
        # tray-icon 的托盘窗口收 WM_USER_TRAYICON(6002)，lParam 是鼠标消息 WM_LBUTTONUP(0x0202)
        $windows = [ShellWindows]::TrayWindows($ProcessId)
        foreach ($window in $windows) { [ShellWindows]::PostMessage($window, 6002, [IntPtr]::Zero, [IntPtr]0x0202) | Out-Null }
        @{ clicked = $windows.Count } | ConvertTo-Json -Compress
    }
    'drag' {
        if ($File) {
            $effect = [ShellWindows]::DragFile($File, $FromX, $FromY, $ToX, $ToY)
            @{ effect = $effect } | ConvertTo-Json -Compress
        } else {
            [ShellWindows]::Drag($FromX, $FromY, $ToX, $ToY)
            @{ dragged = $true } | ConvertTo-Json -Compress
        }
    }
    'downloads' {
        $path = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path
        @{ path = $path } | ConvertTo-Json -Compress
    }
}
