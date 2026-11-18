// Independent receiver for live acceptance tests. It never injects input.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

namespace OpenDesktopHid
{
    internal sealed class InputObserver : Form
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct RawDevice { internal ushort Page, Usage; internal uint Flags; internal IntPtr Target; }
        [StructLayout(LayoutKind.Sequential)]
        private struct HidAttributes { internal int Size; internal ushort Vendor, Product, Version; }
        [StructLayout(LayoutKind.Sequential)]
        private struct Point { internal int X, Y; }
        [DllImport("hid.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        private static extern bool HidD_GetAttributes(SafeFileHandle handle, ref HidAttributes attributes);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(string path, uint access, int share, IntPtr security, int creation, int flags, IntPtr template);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool GetPhysicalCursorPos(out Point point);
        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterRawInputDevices(RawDevice[] devices, uint count, uint size);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetRawInputData(IntPtr raw, uint command, IntPtr data, ref uint size, uint headerSize);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetRawInputDeviceInfo(IntPtr device, uint command, StringBuilder data, ref uint size);
        private readonly TextBox log = new TextBox { Multiline = true, ReadOnly = true, Dock = DockStyle.Fill, ScrollBars = ScrollBars.Vertical };
        private readonly Label status = new Label { Dock = DockStyle.Top, Height = 65 };
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private readonly StreamWriter output;
        private readonly string statePath;
        private readonly Timer stateTimer = new Timer { Interval = 100 };
        private readonly Dictionary<IntPtr, bool> identities = new Dictionary<IntPtr, bool>();
        private long sequence;
        internal InputObserver(string outputPath)
        {
            Text = "OpenDesktopHID Input Observer"; Width = 900; Height = 500;
            StartPosition = FormStartPosition.CenterScreen;
            WindowState = FormWindowState.Maximized;
            output = new StreamWriter(outputPath, false, Encoding.UTF8); output.AutoFlush = true;
            statePath = outputPath + ".state.json";
            status.Text = "Receiver only. Keep this window focused. Only vmulti-compatible device events are recorded.\r\nLog: " + outputPath;
            Controls.Add(log); Controls.Add(status);
            stateTimer.Tick += delegate { WriteState(); };
            Shown += delegate { stateTimer.Start(); WriteState(); };
            FormClosed += delegate { stateTimer.Stop(); stateTimer.Dispose(); output.Dispose(); };
        }
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // Flags=0: foreground only. No global/background keyboard recording.
            RawDevice[] devices = {
                new RawDevice { Page = 1, Usage = 2, Flags = 0, Target = Handle },
                new RawDevice { Page = 1, Usage = 6, Flags = 0, Target = Handle }
            };
            if (!RegisterRawInputDevices(devices, 2, (uint)Marshal.SizeOf(typeof(RawDevice)))) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        private void WriteState()
        {
            Point cursor; GetPhysicalCursorPos(out cursor);
            System.Drawing.Rectangle client = RectangleToScreen(ClientRectangle);
            System.Drawing.Rectangle primary = Screen.PrimaryScreen.Bounds;
            System.Drawing.Rectangle desktop = SystemInformation.VirtualScreen;
            File.WriteAllText(statePath, json.Serialize(new { observedUtc = DateTime.UtcNow.ToString("o"), processId = System.Diagnostics.Process.GetCurrentProcess().Id, foreground = GetForegroundWindow() == Handle, cursorX = cursor.X, cursorY = cursor.Y, clientLeft = client.Left, clientTop = client.Top, clientWidth = client.Width, clientHeight = client.Height, primaryWidth = primary.Width, primaryHeight = primary.Height, desktopLeft = desktop.Left, desktopTop = desktop.Top, desktopWidth = desktop.Width, desktopHeight = desktop.Height, events = sequence }));
        }
        private bool IsOurDevice(IntPtr device)
        {
            bool cached; if (identities.TryGetValue(device, out cached)) return cached;
            uint chars = 0;
            if (GetRawInputDeviceInfo(device, 0x20000007, null, ref chars) == uint.MaxValue || chars == 0 || chars > 4096) return false;
            StringBuilder name = new StringBuilder((int)chars + 1);
            if (GetRawInputDeviceInfo(device, 0x20000007, name, ref chars) == uint.MaxValue) return false;
            // VHF paths do not contain VID/PID strings. Read actual HID
            // attributes, with zero desired access even for mouse/keyboard TLCs.
            bool ours = false;
            using (SafeFileHandle file = CreateFile(name.ToString(), 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero))
            {
                HidAttributes attributes = new HidAttributes(); attributes.Size = Marshal.SizeOf(typeof(HidAttributes));
                ours = !file.IsInvalid && HidD_GetAttributes(file, ref attributes) && attributes.Vendor == 0x00ff && attributes.Product == 0xbacc && attributes.Version == 0x0100;
            }
            identities[device] = ours;
            return ours;
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x00ff)
            {
                uint headerSize = (uint)(8 + 2 * IntPtr.Size), size = 0;
                if (GetRawInputData(message.LParam, 0x10000003, IntPtr.Zero, ref size, headerSize) != uint.MaxValue && size >= headerSize && size <= 4096)
                {
                    IntPtr raw = Marshal.AllocHGlobal((int)size);
                    try
                    {
                        uint received = GetRawInputData(message.LParam, 0x10000003, raw, ref size, headerSize);
                        if (received == size && IsOurDevice(Marshal.ReadIntPtr(raw, 8)))
                        {
                            int offset = (int)headerSize, type = Marshal.ReadInt32(raw, 0);
                            Point cursor; GetPhysicalCursorPos(out cursor);
                            object record = null;
                            if (type == 0 && size >= headerSize + 24)
                                record = new { sequence = ++sequence, kind = "mouse", absolute = (Marshal.ReadInt16(raw, offset) & 1) != 0, buttons = (ushort)Marshal.ReadInt16(raw, offset + 4), wheelData = Marshal.ReadInt16(raw, offset + 6), x = Marshal.ReadInt32(raw, offset + 12), y = Marshal.ReadInt32(raw, offset + 16), cursorX = cursor.X, cursorY = cursor.Y };
                            if (type == 1 && size >= headerSize + 16)
                                record = new { sequence = ++sequence, kind = "keyboard", scanCode = (ushort)Marshal.ReadInt16(raw, offset), flags = (ushort)Marshal.ReadInt16(raw, offset + 2), virtualKey = (ushort)Marshal.ReadInt16(raw, offset + 6) };
                            if (record != null)
                            {
                                string line = json.Serialize(record);
                                output.WriteLine(line);
                                if (log.TextLength > 32000) log.Clear();
                                log.AppendText(line + Environment.NewLine);
                                WriteState();
                            }
                        }
                    }
                    finally { Marshal.FreeHGlobal(raw); }
                }
            }
            base.WndProc(ref message);
        }
        [STAThread]
        private static void Main(string[] args)
        {
            try
            {
                if (args.Length != 1 || !Path.IsPathRooted(args[0])) throw new ArgumentException("Pass one absolute output JSONL path in the operational data directory");
                SetProcessDpiAwarenessContext(new IntPtr(-4));
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (InputObserver observer = new InputObserver(args[0])) Application.Run(observer);
            }
            catch (Exception error) { MessageBox.Show(error.Message, "OpenDesktopHID observer error"); Environment.ExitCode = 1; }
        }
    }
}
