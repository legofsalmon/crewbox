// The Windows tray icon for the box.
//
// Same problem the macOS menu-bar wrapper solves: the box is a Node single-file
// executable. Started from Explorer it shows a console window that someone
// closes, or none at all, and then there is a server running with nothing to
// click and no obvious way to stop it.
//
// This is deliberately tiny and knows almost nothing about crewbox. Everything
// it shows comes from box-status.json, which the box writes once it is
// listening (server/src/box.ts). It is compiled at build time with csc.exe from
// the .NET Framework, which is present on every Windows 10 and 11 machine and
// on the CI runner — so it adds nothing to install and about 15 KB to ship.
//
// Build: csc /target:winexe /out:crewbox-tray.exe CrewboxTray.cs
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Windows.Forms;

/// <summary>A newer release the box heard about. Absent most of the time.</summary>
[DataContract]
public class UpdateInfo
{
    [DataMember(Name = "version")] public string Version { get; set; }
    [DataMember(Name = "url")] public string Url { get; set; }
}

[DataContract]
public class BoxStatus
{
    [DataMember(Name = "pid")] public int Pid { get; set; }
    [DataMember(Name = "port")] public int Port { get; set; }
    [DataMember(Name = "joinUrl")] public string JoinUrl { get; set; }
    [DataMember(Name = "urls")] public string[] Urls { get; set; }
    [DataMember(Name = "eventPin")] public string EventPin { get; set; }
    [DataMember(Name = "eventName")] public string EventName { get; set; }
    [DataMember(Name = "version")] public string Version { get; set; }
    // IsRequired defaults to false, so a status file written by a box that
    // predates this field still decodes — which is what lets a helper and a
    // box be different versions, the normal state after an update.
    [DataMember(Name = "update")] public UpdateInfo Update { get; set; }
}

public class CrewboxTray : ApplicationContext
{
    private readonly NotifyIcon icon;
    private readonly Timer poll;
    private readonly string dataDir;
    private BoxStatus status;

    [STAThread]
    public static void Main(string[] args)
    {
        // The box passes its data directory, because it may have been
        // overridden with DATA_DIR and this helper has no way to know that.
        string dir = args.Length > 0
            ? args[0]
            : Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".crewbox", "data");
        Application.EnableVisualStyles();
        Application.Run(new CrewboxTray(dir));
    }

    public CrewboxTray(string dir)
    {
        dataDir = dir;
        icon = new NotifyIcon
        {
            Icon = BuildIcon(),
            Text = "Crewbox",
            Visible = true,
            ContextMenuStrip = new ContextMenuStrip(),
        };
        // Rebuild on open rather than on a timer: the menu is only ever seen
        // at the moment it is opened, so this is both fresher and cheaper.
        icon.ContextMenuStrip.Opening += (s, e) => { Read(); BuildMenu(); };
        icon.DoubleClick += (s, e) => OpenUrl(status == null ? null : status.JoinUrl);

        Read();
        BuildMenu();

        // The tray icon must not outlive the box, or it becomes its own
        // version of the bug this fixes: something claiming to be a running
        // box that isn't.
        poll = new Timer { Interval = 3000 };
        poll.Tick += (s, e) =>
        {
            Read();
            if (status == null && !Directory.Exists(dataDir)) Quit();
            if (status == null) { icon.Text = "Crewbox — not running"; Quit(); }
        };
        poll.Start();
    }

    /// <summary>The box's published status, or null when it isn't running.</summary>
    /// <remarks>
    /// A power cut leaves the file behind, so the pid is checked rather than
    /// trusted. Reporting a dead box as running is the one thing worse than no
    /// tray icon at all — the only reason anyone looks here is to find out.
    /// </remarks>
    private void Read()
    {
        status = null;
        try
        {
            string path = Path.Combine(dataDir, "box-status.json");
            if (!File.Exists(path)) return;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                var serializer = new DataContractJsonSerializer(typeof(BoxStatus));
                var parsed = (BoxStatus)serializer.ReadObject(stream);
                if (parsed == null || parsed.Pid == 0) return;
                try { Process.GetProcessById(parsed.Pid); }
                catch (ArgumentException) { return; }  // no such process
                status = parsed;
            }
        }
        catch
        {
            // A half-written file during startup, or a lock. Next poll picks
            // it up; there is nothing useful to report for one missed tick.
        }
    }

    private void BuildMenu()
    {
        var menu = icon.ContextMenuStrip;
        menu.Items.Clear();

        if (status != null)
        {
            string title = string.IsNullOrEmpty(status.EventName) ? "Crewbox" : status.EventName;
            menu.Items.Add(Header(title + " — running"));
            if (!string.IsNullOrEmpty(status.Version)) menu.Items.Add(Header("Version " + status.Version));

            // The box does the asking; this only draws what it was told.
            //
            // Opens the admin panel, not the release page. Downloading a file
            // from a browser was the only answer before the box could update
            // itself; now it is the wrong one, and it would leave somebody
            // holding a binary with no idea what to do with it. Nothing is
            // installed by this click either — the panel asks twice, and shows
            // what a restart would interrupt before it does anything.
            if (status.Update != null && !string.IsNullOrEmpty(status.Update.Version))
            {
                string url = status.JoinUrl + "?admin";
                var item = new ToolStripMenuItem(
                    "Update available: " + status.Update.Version, null, (s, e) => OpenUrl(url));
                item.Font = new Font(item.Font, FontStyle.Bold);
                menu.Items.Add(item);
            }

            menu.Items.Add(new ToolStripSeparator());

            Add(menu, "Open the join page", (s, e) => OpenUrl(status.JoinUrl));
            Add(menu, "Open the QR poster page", (s, e) => OpenUrl(status.JoinUrl + "/connect"));
            Add(menu, "Copy the join link", (s, e) => Copy(status.JoinUrl));
            Add(menu, "Copy the event PIN  (" + status.EventPin + ")", (s, e) => Copy(status.EventPin));

            if (status.Urls != null && status.Urls.Length > 1)
            {
                // More than one network means more than one address the crew
                // might have to type, and which one works is a property of the
                // Wi-Fi they are on rather than anything the box can decide.
                var others = new ToolStripMenuItem("Other addresses");
                foreach (string url in status.Urls)
                {
                    string captured = url;
                    others.DropDownItems.Add(new ToolStripMenuItem(captured, null, (s, e) => Copy(captured)));
                }
                menu.Items.Add(others);
            }

            icon.Text = Truncate(title + " — running");
        }
        else
        {
            menu.Items.Add(Header("Crewbox — not running"));
            icon.Text = "Crewbox — not running";
        }

        menu.Items.Add(new ToolStripSeparator());
        Add(menu, "Open the data folder", (s, e) => OpenUrl(dataDir));
        menu.Items.Add(new ToolStripSeparator());
        // Named for what it does. "Exit" alone reads as closing this icon, and
        // the thing someone wants to be certain of is that the box stopped.
        Add(menu, "Stop Crewbox and exit", (s, e) => StopBoxAndQuit());
    }

    private static ToolStripMenuItem Header(string text)
    {
        return new ToolStripMenuItem(text) { Enabled = false };
    }

    private static void Add(ContextMenuStrip menu, string text, EventHandler handler)
    {
        menu.Items.Add(new ToolStripMenuItem(text, null, handler));
    }

    /// <summary>NotifyIcon.Text throws above 63 characters.</summary>
    private static string Truncate(string text)
    {
        return text.Length <= 63 ? text : text.Substring(0, 60) + "...";
    }

    private void StopBoxAndQuit()
    {
        Read();
        if (status != null)
        {
            try
            {
                var process = Process.GetProcessById(status.Pid);
                // Windows has no SIGTERM to send another process, so this is a
                // hard stop. Safe here: the store is SQLite in WAL mode and the
                // whole product assumes hard power cuts, which is a rougher
                // stop than this one.
                process.Kill();
                process.WaitForExit(5000);
            }
            catch
            {
                // Already gone, or someone else's process. Either way there is
                // nothing left for this icon to do.
            }
            // The box only removes this itself on a clean exit, which a Kill
            // is not. Readers check the pid, so a leftover is harmless — but
            // tidy anyway, so `--status` doesn't have to reason about it.
            try { File.Delete(Path.Combine(dataDir, "box-status.json")); } catch { }
        }
        Quit();
    }

    private void Quit()
    {
        poll.Stop();
        // Explicitly, and before exiting: a NotifyIcon that is not disposed
        // leaves a ghost in the tray until the user mouses over it.
        icon.Visible = false;
        icon.Dispose();
        ExitThread();
    }

    private static void OpenUrl(string target)
    {
        if (string.IsNullOrEmpty(target)) return;
        try { Process.Start(target); } catch { }
    }

    private static void Copy(string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        try { Clipboard.SetText(text); } catch { }
    }

    /// <summary>
    /// Drawn rather than shipped as a .ico file.
    /// </summary>
    /// <remarks>
    /// A tray icon is 16 or 32 pixels, so there is nothing here a real icon
    /// file would buy — and generating one at build time would mean an ICO
    /// encoder in the build for an image this size. The amber is the accent
    /// the web app uses, so the tray matches what the crew are looking at.
    /// </remarks>
    private static Icon BuildIcon()
    {
        using (var bitmap = new Bitmap(32, 32))
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using (var brush = new SolidBrush(ColorTranslator.FromHtml("#f5b73e")))
            using (var path = new GraphicsPath())
            {
                const int r = 8;
                var box = new Rectangle(1, 1, 30, 30);
                path.AddArc(box.X, box.Y, r, r, 180, 90);
                path.AddArc(box.Right - r, box.Y, r, r, 270, 90);
                path.AddArc(box.Right - r, box.Bottom - r, r, r, 0, 90);
                path.AddArc(box.X, box.Bottom - r, r, r, 90, 90);
                path.CloseFigure();
                g.FillPath(brush, path);
            }
            using (var font = new Font("Segoe UI", 17, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var text = new SolidBrush(ColorTranslator.FromHtml("#10151d")))
            using (var format = new StringFormat
            {
                Alignment = StringAlignment.Center,
                LineAlignment = StringAlignment.Center,
            })
            {
                g.DrawString("C", font, text, new RectangleF(0, 0, 32, 32), format);
            }
            return Icon.FromHandle(bitmap.GetHicon());
        }
    }
}
