// A small vmulti transport, compiled with the .NET Framework compiler in Windows.
// Wire layouts follow vmulti; see THIRD_PARTY_NOTICES.md.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace OpenDesktopHid
{
    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct InterfaceData { internal int Size; internal Guid ClassGuid; internal int Flags; internal IntPtr Reserved; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct Attributes { internal int Size; internal ushort Vendor, Product, Version; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct Caps
        {
            internal ushort Usage, UsagePage, InputBytes, OutputBytes, FeatureBytes;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] internal ushort[] Reserved;
            internal ushort Links, InputButtons, InputValues, InputIndices, OutputButtons, OutputValues, OutputIndices, FeatureButtons, FeatureValues, FeatureIndices;
        }
        [DllImport("hid.dll")] internal static extern void HidD_GetHidGuid(out Guid guid);
        [DllImport("hid.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.U1)] internal static extern bool HidD_GetAttributes(SafeFileHandle handle, ref Attributes attributes);
        [DllImport("hid.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.U1)] internal static extern bool HidD_GetPreparsedData(SafeFileHandle handle, out IntPtr data);
        [DllImport("hid.dll")] [return: MarshalAs(UnmanagedType.U1)] internal static extern bool HidD_FreePreparsedData(IntPtr data);
        [DllImport("hid.dll")] internal static extern int HidP_GetCaps(IntPtr data, out Caps caps);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr SetupDiGetClassDevs(ref Guid guid, IntPtr enumerator, IntPtr hwnd, int flags);
        [DllImport("setupapi.dll", SetLastError = true)] internal static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr dev, ref Guid guid, int index, ref InterfaceData data);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref InterfaceData data, IntPtr detail, int size, out int required, IntPtr dev);
        [DllImport("setupapi.dll", SetLastError = true)] internal static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern SafeFileHandle CreateFile(string path, uint access, int share, IntPtr security, int creation, int flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool WriteFile(SafeFileHandle handle, byte[] data, int count, out int written, IntPtr overlapped);
        [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
        [DllImport("kernel32.dll")] internal static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder information, uint length, out uint needed);
        [DllImport("user32.dll")] internal static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] internal static extern int GetSystemMetrics(int index);
        [StructLayout(LayoutKind.Sequential)] internal struct Point { internal int X, Y; }
        [DllImport("user32.dll")] internal static extern bool GetPhysicalCursorPos(out Point point);
        [DllImport("user32.dll")] internal static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] internal static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport("gdi32.dll", SetLastError = true)] internal static extern bool BitBlt(IntPtr destination, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint operation);
    }

    internal static class DesktopSession
    {
        internal static uint CurrentId()
        {
            using (System.Diagnostics.Process process = System.Diagnostics.Process.GetCurrentProcess()) return (uint)process.SessionId;
        }
        internal static bool MatchesConsole(uint processSession, uint consoleSession)
        {
            return consoleSession != uint.MaxValue && processSession == consoleSession;
        }
        internal static bool IsDefaultDesktop(string name) { return string.Equals(name, "Default", StringComparison.OrdinalIgnoreCase); }
        internal static string InputDesktopName()
        {
            IntPtr desktop = Native.OpenInputDesktop(0, false, 1);
            if (desktop == IntPtr.Zero) return null;
            try {
                StringBuilder name = new StringBuilder(256); uint needed;
                return Native.GetUserObjectInformation(desktop, 2, name, (uint)(name.Capacity * 2), out needed) ? name.ToString() : null;
            } finally { Native.CloseDesktop(desktop); }
        }
        internal static void RequireConsole()
        {
            uint current = CurrentId(), console = Native.WTSGetActiveConsoleSessionId();
            if (!MatchesConsole(current, console)) throw new InvalidOperationException("HID_CONSOLE_SESSION_REQUIRED: processSession=" + current + "; consoleSession=" + console + ". RDP input needs a separate session-aware backend.");
            if (!IsDefaultDesktop(InputDesktopName())) throw new InvalidOperationException("HID_INTERACTIVE_DESKTOP_REQUIRED: locked and secure desktops are not supported");
        }
        internal static void RequireControlledConsole(bool secureSupport) {
            uint current=CurrentId(),console=Native.WTSGetActiveConsoleSessionId();
            if(!MatchesConsole(current,console))throw new InvalidOperationException("HID_CONSOLE_SESSION_REQUIRED");
            string desktop=InputDesktopName();if(!IsDefaultDesktop(desktop)&&!(secureSupport&&(desktop=="Winlogon"||desktop==null)))throw new InvalidOperationException("HID_INTERACTIVE_DESKTOP_REQUIRED");
        }
    }

    internal sealed class Candidate
    {
        public string Path;
        public int OutputBytes;
        public int Version;
    }

    internal static class Wire
    {
        internal static byte[] Decode(string hex)
        {
            if (hex == null || hex.Length > 18 || hex.Length % 2 != 0) throw new ArgumentException("Invalid report hex length");
            byte[] report = new byte[hex.Length / 2];
            for (int i = 0; i < report.Length; i++) report[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
            Validate(report);
            return report;
        }
        internal static void Validate(byte[] r)
        {
            if (r == null || r.Length == 0) throw new ArgumentException("Empty report");
            if (r[0] == 4 && r.Length == 5)
            {
                if (r[1] > 7 || r[2] == 128 || r[3] == 128 || r[4] == 128) throw new ArgumentException("Relative value outside descriptor range");
                return;
            }
            if (r[0] == 3 && r.Length == 7)
            {
                if (r[1] > 7 || r[3] > 127 || r[5] > 127 || r[6] == 128) throw new ArgumentException("Absolute value outside descriptor range");
                return;
            }
            if (r[0] == 7 && r.Length == 9 && r[2] == 0)
            {
                HashSet<byte> keys = new HashSet<byte>();
                for (int i = 3; i < 9; i++)
                {
                    if (r[i] == 0) continue;
                    if (r[i] < 4 || r[i] > 0x65 || !keys.Add(r[i])) throw new ArgumentException("Invalid keyboard usage");
                }
                return;
            }
            throw new ArgumentException("Unsupported report ID or length");
        }
        internal static byte[] Pack(byte[] report)
        {
            Validate(report);
            byte[] packet = new byte[65]; packet[0] = 0x40; packet[1] = (byte)report.Length;
            Array.Copy(report, 0, packet, 2, report.Length);
            return packet;
        }
    }

    internal sealed class Device : IDisposable
    {
        private SafeFileHandle handle;
        private byte[] absolute;
        private bool driverHeartbeat;
        private readonly Action<byte[]> packetWriter;
        // Self-tests exercise the real Send/Release code without opening HID.
        internal Device(Action<byte[]> writer) { if (writer == null) throw new ArgumentNullException("writer"); packetWriter = writer; }
        internal static List<Candidate> Find()
        {
            Guid guid; Native.HidD_GetHidGuid(out guid);
            IntPtr set = Native.SetupDiGetClassDevs(ref guid, IntPtr.Zero, IntPtr.Zero, 0x12);
            if (set == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            List<Candidate> candidates = new List<Candidate>();
            try
            {
                for (int index = 0; ; index++)
                {
                    Native.InterfaceData data = new Native.InterfaceData(); data.Size = Marshal.SizeOf(typeof(Native.InterfaceData));
                    if (!Native.SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref guid, index, ref data))
                    {
                        int error = Marshal.GetLastWin32Error(); if (error == 259) break;
                        throw new Win32Exception(error);
                    }
                    int required;
                    Native.SetupDiGetDeviceInterfaceDetail(set, ref data, IntPtr.Zero, 0, out required, IntPtr.Zero);
                    if (required < 6 || required > 65536) throw new InvalidOperationException("Invalid interface detail size");
                    IntPtr detail = Marshal.AllocHGlobal(required);
                    try
                    {
                        Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : 6);
                        if (!Native.SetupDiGetDeviceInterfaceDetail(set, ref data, detail, required, out required, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
                        // DevicePath starts at byte 4 even though the x64 cbSize is 8.
                        string path = Marshal.PtrToStringUni(new IntPtr(detail.ToInt64() + 4));
                        using (SafeFileHandle file = Native.CreateFile(path, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero))
                        {
                            if (file.IsInvalid) continue;
                            Native.Attributes attrs = new Native.Attributes(); attrs.Size = Marshal.SizeOf(typeof(Native.Attributes));
                            if (!Native.HidD_GetAttributes(file, ref attrs) || attrs.Vendor != 0x00ff || attrs.Product != 0xbacc) continue;
                            IntPtr preparsed;
                            if (!Native.HidD_GetPreparsedData(file, out preparsed)) continue;
                            try
                            {
                                Native.Caps caps;
                                if (Native.HidP_GetCaps(preparsed, out caps) == 0x00110000 && caps.UsagePage == 0xff00 && caps.Usage == 1 && caps.OutputBytes == 65)
                                    candidates.Add(new Candidate { Path = path, OutputBytes = caps.OutputBytes, Version = attrs.Version });
                            }
                            finally { Native.HidD_FreePreparsedData(preparsed); }
                        }
                    }
                    finally { Marshal.FreeHGlobal(detail); }
                }
            }
            finally { Native.SetupDiDestroyDeviceInfoList(set); }
            return candidates;
        }
        internal Device()
        {
            List<Candidate> candidates = Find();
            if (candidates.Count != 1) throw new InvalidOperationException(candidates.Count == 0 ? "VMULTI_NOT_FOUND" : "MULTIPLE_VMULTI_DEVICES");
            driverHeartbeat = candidates[0].Version == 0x0100;
            if (!driverHeartbeat) throw new InvalidOperationException("OPENDESKTOPHID_WATCHDOG_DRIVER_REQUIRED");
            handle = Native.CreateFile(candidates[0].Path, 0xc0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
        }
        internal void Send(byte[] report)
        {
            byte[] packet = Wire.Pack(report);
            // A failing write may already have reached the driver. Retain a
            // possible button-down until a button-up is acknowledged.
            if (report[0] == 3 && report[1] != 0) absolute = (byte[])report.Clone();
            Write(packet);
            if (report[0] == 3) absolute = (byte[])report.Clone();
        }
        private void Write(byte[] packet)
        {
            if (packetWriter != null) { packetWriter((byte[])packet.Clone()); return; }
            int written;
            if (!Native.WriteFile(handle, packet, packet.Length, out written, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (written != packet.Length) throw new InvalidOperationException("Partial HID write");
        }
        internal void Heartbeat()
        {
            // OpenDesktopHID v0.1 extension: an empty envelope refreshes the
            // kernel watchdog without repeating movement or key transitions.
            if (driverHeartbeat) { byte[] packet = new byte[65]; packet[0] = 0x40; Write(packet); }
        }
        internal void Release()
        {
            Exception failure = null;
            List<byte[]> reports = new List<byte[]> { new byte[] { 4, 0, 0, 0, 0 }, new byte[] { 7, 0, 0, 0, 0, 0, 0, 0, 0 } };
            // Replaying a historical coordinate moves the pointer after a
            // relative gesture, even across leases. Only release a held or
            // uncertain absolute button; a completed absolute click needs none.
            if (absolute != null && absolute[1] != 0) { byte[] neutral = (byte[])absolute.Clone(); neutral[1] = 0; neutral[6] = 0; reports.Add(neutral); }
            foreach (byte[] report in reports) { try { Send(report); } catch (Exception error) { if (failure == null) failure = error; } }
            if (failure != null) throw failure;
        }
        public void Dispose() { handle.Dispose(); }
    }

    internal static class Program
    {
        private const int WatchdogMs = 2000;
        private const int MaxRequestJsonChars = 8192;
        // At most 1024 UTF-16 units -> 2048 physical strokes, including accents.
        // Each bounded stroke object takes at most 27 JSON characters. The
        // complete reply/context fits below 64 Ki characters (tested below).
        private const int MaxResponseJsonChars = 65536;
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxResponseJsonChars, RecursionLimit = 16 };
        private static readonly object OutputLock = new object();
        private static void Emit(object value) { lock (OutputLock) Console.WriteLine(Json.Serialize(value)); }
        private static void EmitPlan(object value) {
            lock(OutputLock) {
                string payload;
                // A serialization rejection here is before every text stroke.
                // Console/transport write failures must still stop the helper.
                try{payload=Json.Serialize(value);}
                catch(InvalidOperationException){throw new SecurePolicyException("Text plan response exceeds its bounded JSON format; no text input sent");}
                catch(ArgumentException){throw new SecurePolicyException("Text plan response cannot be serialized; no text input sent");}
                Console.WriteLine(payload);
            }
        }
        private static bool Down(int key) { return (Native.GetAsyncKeyState(key) & 0x8000) != 0; }
        private static int Serve()
        {
            // Hardware-like HID must not be sent from an unrelated RDP session.
            // There is no silent SendInput fallback and no automatic tscon.
            bool secureSupport=SecureDesktopClient.Available()&&SecureDesktopClient.EnableStopMonitor();
            DesktopSession.RequireControlledConsole(secureSupport);
            // Single writer across helper processes in this Windows session.
            using (Mutex mutex = new Mutex(false, "Local\\OpenDesktopHID-vmulti"))
            {
                bool owned;
                try { owned = mutex.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
                if (!owned) throw new InvalidOperationException("DESKTOP_ALREADY_CONTROLLED");
                try
                {
                    // Before any heartbeat can prolong stale held state, allow
                    // our driver's 3-second watchdog to clear a previous helper.
                    // Holding the mutex prevents another helper refreshing it.
                    Thread.Sleep(3500);
                    DesktopSession.RequireControlledConsole(secureSupport);
                    using (Device device = new Device())
                    {
                        object gate = new object(); bool stopped = false, released = false, paused = false;
                        if(secureSupport&&!DesktopSession.IsDefaultDesktop(DesktopSession.InputDesktopName())){device.Release();mutex.ReleaseMutex();owned=false;paused=true;released=true;}
                        System.Diagnostics.Stopwatch heartbeat = System.Diagnostics.Stopwatch.StartNew();
                        // The service must send ping at least once per second. Operator
                        // Ctrl+Alt+F12 revokes this process; a new helper is required.
                        using (Timer timer = new Timer(delegate(object unused)
                        {
                            lock (gate)
                            {
                                if (stopped) return;
                                string desktop=DesktopSession.InputDesktopName();
                                bool secure=secureSupport&&(desktop=="Winlogon"||desktop==null);
                                if(secure&&!paused&&owned){try{device.Release();released=true;}catch{}}
                                string reason = !DesktopSession.MatchesConsole(DesktopSession.CurrentId(), Native.WTSGetActiveConsoleSessionId()) ? "console_session_changed" :
                                    !DesktopSession.IsDefaultDesktop(desktop)&&!secure ? "interactive_desktop_unavailable" :
                                    heartbeat.ElapsedMilliseconds > WatchdogMs ? "heartbeat_timeout" :
                                    ((Down(0x11) && Down(0x12) && Down(0x7b))||SecureDesktopClient.StopRequested()) ? "operator_hotkey" : null;
                                if (reason != null)
                                {
                                    stopped = true;
                                    try { if(!paused&&owned)device.Release(); released = true; Emit(new { type = "stopped", released = true, error = reason }); }
                                    catch (Exception error) { Emit(new { type = "stopped", released = false, error = error.Message }); }
                                }
                            }
                        }, null, 100, 100))
                        {
                            bool administrator = new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
                            Emit(new { type = "ready", driver = "vmulti-compatible", live = true, processId = System.Diagnostics.Process.GetCurrentProcess().Id, currentSession = DesktopSession.CurrentId(), consoleSession = Native.WTSGetActiveConsoleSessionId(), watchdogTimeoutMs = WatchdogMs, administrator = administrator, secureDesktopSupported=secureSupport,inputPaused=paused });
                            try
                            {
                                string line;
                                while ((line = Console.ReadLine()) != null)
                                {
                                    if (line.Length > MaxRequestJsonChars) throw new ArgumentException("Request too large");
                                    Dictionary<string, object> req = new JavaScriptSerializer { MaxJsonLength = MaxRequestJsonChars }.Deserialize<Dictionary<string, object>>(line);
                                    object id; if (!req.TryGetValue("id", out id)) throw new ArgumentException("Request id required");
                                    lock (gate)
                                    {
                                        if (stopped) throw new InvalidOperationException("SESSION_STOPPED");
                                        string op = req.ContainsKey("op") ? req["op"] as string : null;
                                        try {
                                            DesktopSession.RequireControlledConsole(secureSupport);
                                            string currentDesktop=DesktopSession.InputDesktopName();bool secure=secureSupport&&(currentDesktop=="Winlogon"||currentDesktop==null);
                                            if(secure&&!paused){device.Release();released=true;mutex.ReleaseMutex();owned=false;paused=true;Emit(new{type="desktop_transition",inputPaused=true,desktop="Winlogon"});}
                                            if(!secure&&paused){try{owned=mutex.WaitOne(0);}catch(AbandonedMutexException){owned=true;}if(!owned)throw new SecurePolicyException("Secure desktop is still controlled");paused=false;device.Release();released=true;Emit(new{type="desktop_transition",inputPaused=false,desktop="Default"});}
                                            if (op == "ping") {if(!paused)device.Heartbeat();heartbeat.Restart();}
                                            else if(op=="plan_text") {
                                                if(paused)throw new SecurePolicyException("Text input is only available on the ordinary desktop");
                                                var plan=KeyboardText.Plan(req.ContainsKey("text")?req["text"] as string:null,req.ContainsKey("layout")?req["layout"] as string:"active");
                                                heartbeat.Restart();EmitPlan(new{id=id,ok=true,plan=plan});continue;
                                            }
                                            else if(op=="send") {
                                                byte[] report=Wire.Decode(req["report"] as string);heartbeat.Restart();
                                                if(paused){
                                                    bool neutral=(report[0]==7&&report.Skip(1).All(value=>value==0)) || (report[0]==4&&report.Skip(1).All(value=>value==0));
                                                    if(!neutral){object challenge,deadline;req.TryGetValue("promptId",out challenge);req.TryGetValue("deadlineUtcMs",out deadline);if(!(challenge is string))throw new SecurePolicyException("Capture a fresh UAC screenshot before input");SecureDesktopClient.Call(new{op="input",promptId=(string)challenge,report=req["report"] as string,deadlineUtcMs=deadline});}
                                                }else{DesktopSession.RequireConsole();if(req.ContainsKey("promptId")){if((report[0]==3||report[0]==4)&&report[1]==0&&report[report.Length-1]==0){device.Release();released=true;}else if(report[0]==7&&report.Skip(1).All(value=>value==0)){device.Release();released=true;}else throw new SecurePolicyException("UAC closed; capture a fresh ordinary desktop before input");}else{KeyboardText.RequireContext(req);device.Send(report);released=false;}}
                                                heartbeat.Restart();
                                            }
                                            else if(op=="release"){if(!paused)device.Release();released=true;}
                                            else throw new ArgumentException("Unknown operation");
                                            Emit(new { id = id, ok = true, driverAcknowledged = op == "send"&&!paused, secureDelegated=op=="send"&&paused });
                                        }catch(SecurePolicyException error){heartbeat.Restart();Emit(new{id=id,ok=false,error=error.Message,policyRefusal=true,inputSent=false});}
                                    }
                                }
                            }
                            finally { lock (gate) { stopped = true; if (!released&&owned) device.Release(); } }
                        }
                    }
                }
                finally { if(owned)mutex.ReleaseMutex(); }
            }
            return 0;
        }
        private static int MouseReleaseSelfTest()
        {
            int checks = 0;
            Action<bool,string> verify = (condition,name) => { if (!condition) throw new Exception("Mouse release: " + name); checks++; };
            Func<byte[],byte[]> report = packet => packet.Skip(2).Take(packet[1]).ToArray();
            byte[] down = Wire.Decode("03017b00c80100"), up = Wire.Decode("03007b00c80100");
            var sent = new List<byte[]>(); var device = new Device(packet => sent.Add(packet));
            device.Release(); verify(sent.All(p => p[2] != 3), "fresh release stays relative");
            device.Send(up); device.Send(Wire.Decode("040011f700")); device.Send(Wire.Decode("0401000000")); device.Send(Wire.Decode("0400000000"));
            int begin = sent.Count; device.Release(); verify(sent.Skip(begin).All(p => p[2] != 3), "relative click does not replay old absolute position");
            device.Send(down); device.Send(up); device.Send(Wire.Decode("0400010000"));
            begin = sent.Count; device.Release(); verify(sent.Skip(begin).All(p => p[2] != 3), "completed absolute click needs no extra absolute release");
            device.Send(Wire.Decode("0400020000")); begin = sent.Count; device.Release();
            verify(sent.Skip(begin).All(p => p[2] != 3), "next owner does not inherit an absolute replay");
            device.Send(down); begin = sent.Count; device.Release();
            verify(sent.Skip(begin).Count(p => p[2] == 3) == 1 && report(sent.Last()).SequenceEqual(up), "held absolute button releases at its intended position");
            begin = sent.Count; device.Release(); verify(sent.Skip(begin).All(p => p[2] != 3), "successful absolute release is idempotent");

            bool fail = true; var uncertainSent = new List<byte[]>();
            var uncertain = new Device(packet => { uncertainSent.Add(packet); if (fail) { fail = false; throw new IOException("simulated lost down acknowledgement"); } });
            bool failed = false; try { uncertain.Send(down); } catch (IOException) { failed = true; }
            uncertain.Release(); verify(failed && report(uncertainSent.Last()).SequenceEqual(up), "uncertain down retains required absolute release");

            bool failUp = false; var retrySent = new List<byte[]>();
            var retry = new Device(packet => { retrySent.Add(packet); if (failUp && packet[2] == 3 && packet[3] == 0) { failUp = false; throw new IOException("simulated lost up acknowledgement"); } });
            retry.Send(down); failUp = true; failed = false;
            try { retry.Send(up); } catch (IOException) { failed = true; }
            begin = retrySent.Count; retry.Release(); verify(failed && retrySent.Skip(begin).Any(p => p[2] == 3), "uncertain up does not discard held state");
            retry.Send(down); failUp = true; failed = false;
            try { retry.Release(); } catch (IOException) { failed = true; }
            begin = retrySent.Count; retry.Release(); verify(failed && retrySent.Skip(begin).Any(p => p[2] == 3), "failed release can be retried safely");
            begin = retrySent.Count; retry.Release(); verify(retrySent.Skip(begin).All(p => p[2] != 3), "retry acknowledgement clears pending absolute state");

            bool failRelative = false; var independentSent = new List<byte[]>();
            var independent = new Device(packet => { independentSent.Add(packet); if (failRelative && packet[2] == 4) { failRelative = false; throw new IOException("simulated relative release failure"); } });
            independent.Send(down); failRelative = true; failed = false; begin = independentSent.Count;
            try { independent.Release(); } catch (IOException) { failed = true; }
            verify(failed && independentSent.Skip(begin).Any(p => p[2] == 7) && report(independentSent.Last()).SequenceEqual(up), "one failed collection does not skip remaining releases");
            verify(independentSent.Where(p => p[2] == 4).All(p => report(p).SequenceEqual(Wire.Decode("0400000000"))), "release never repeats relative displacement or wheel");
            return checks;
        }
        private static int SelfTest()
        {
            int passed = 0;
            passed += MouseReleaseSelfTest();
            KeyboardText.SelfTest();passed++;
            var maximumPlan=new TextPlan{strokes=Enumerable.Range(0,KeyboardText.MaxTextStrokes).Select(_=>new TextStroke{key=101,modifiers=66}).ToArray(),context=new TextContext{window=new string('f',16),foregroundLayout=new string('f',16),capsLock=false},mappingLayout=new string('f',16),characters=KeyboardText.MaxTextUnits};
            string maximumReply=Json.Serialize(new{id=int.MaxValue,ok=true,inputSent=false,plan=maximumPlan});
            if(maximumReply.Length>=MaxResponseJsonChars||maximumReply.Length<=2048)throw new Exception("Text plan response bound failed");
            var roundtrip=Json.Deserialize<Dictionary<string,object>>(maximumReply);
            if(roundtrip==null||!roundtrip.ContainsKey("plan"))throw new Exception("Text plan protocol roundtrip failed");
            bool oldRejected=false;try{new JavaScriptSerializer{MaxJsonLength=2048}.Serialize(new{plan=maximumPlan});}catch(InvalidOperationException){oldRejected=true;}catch(ArgumentException){oldRejected=true;}
            if(!oldRejected)throw new Exception("Text plan regression vector must exceed the previous JSON limit");
            passed+=3;
            bool oversizedRefused=false;try{EmitPlan(new{padding=new string('x',MaxResponseJsonChars)});}catch(SecurePolicyException){oversizedRefused=true;}
            if(!oversizedRefused)throw new Exception("Oversized text plan must be refused before output");passed++;
            if (Marshal.SizeOf(typeof(Native.Caps)) != 64 || Marshal.SizeOf(typeof(Native.Attributes)) != 12 || Marshal.SizeOf(typeof(Native.InterfaceData)) != (IntPtr.Size == 8 ? 32 : 28)) throw new Exception("Windows interop structure size mismatch");
            passed++;
            if (!DesktopSession.MatchesConsole(1, 1) || DesktopSession.MatchesConsole(1, 2) || DesktopSession.MatchesConsole(1, uint.MaxValue)) throw new Exception("Console session guard failed");
            passed += 3;
            if (!DesktopSession.IsDefaultDesktop("Default") || DesktopSession.IsDefaultDesktop("Winlogon") || DesktopSession.IsDefaultDesktop(null)) throw new Exception("Input desktop guard failed");
            passed += 3;
            foreach (string hex in new string[] { "0405817fff", "0301ff7f000001", "070200042800000000" })
            {
                byte[] r = Wire.Decode(hex), p = Wire.Pack(r);
                if (p.Length != 65 || p[0] != 0x40 || p[1] != r.Length) throw new Exception("Wire vector failed");
                for (int i = 0; i < r.Length; i++) if (p[i + 2] != r[i]) throw new Exception("Wire copy failed");
                for (int i = r.Length + 2; i < p.Length; i++) if (p[i] != 0) throw new Exception("Padding failed");
                passed++;
            }
            foreach (string hex in new string[] { "", "0400800000", "0408000000", "03000080000000", "070001000000000000", "070000040400000000", "04000000", "zz" })
            {
                bool rejected = false; try { Wire.Decode(hex); } catch (Exception) { rejected = true; }
                if (!rejected) throw new Exception("Invalid report accepted: " + hex); passed++;
            }
            Emit(new { ok = true, checks = passed, maxTextReplyChars=maximumReply.Length, requestJsonLimit=MaxRequestJsonChars, responseJsonLimit=MaxResponseJsonChars, inputSent = false }); return 0;
        }
        private static int Main(string[] args)
        {
            try
            {
                Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false);
                if (args.Length == 1 && args[0] == "self-test") return SelfTest();
                if(args.Length==1&&args[0]=="plan-text"){
                    string input=Console.ReadLine();if(input==null||input.Length>MaxRequestJsonChars)throw new ArgumentException("Expected bounded text/layout JSON on stdin");
                    var request=new JavaScriptSerializer{MaxJsonLength=MaxRequestJsonChars}.Deserialize<Dictionary<string,object>>(input);
                    EmitPlan(new{ok=true,inputSent=false,plan=KeyboardText.Plan(request["text"] as string,request.ContainsKey("layout")?request["layout"] as string:"active")});return 0;
                }
                if (args.Length == 1 && args[0] == "probe")
                {
                    List<Candidate> candidates = Device.Find();
                    uint current = DesktopSession.CurrentId(), console = Native.WTSGetActiveConsoleSessionId();
                    Emit(new { driver = "vmulti-compatible", candidates = candidates.Count, available = candidates.Count == 1, kernelWatchdog = candidates.Count == 1 && candidates[0].Version == 0x0100, currentSession = current, consoleSession = console, consoleSessionMatched = DesktopSession.MatchesConsole(current, console), inputDesktop = DesktopSession.InputDesktopName(), inputSent = false }); return 0;
                }
                if (args.Length == 3 && args[0] == "capture" && args[1] == "--output") return Capture(args[2]);
                if (args.Length == 2 && args[0] == "serve" && args[1] == "--live") return Serve();
                throw new ArgumentException("Usage: HidTransport.exe self-test | probe | serve --live | capture --output ABSOLUTE_PNG");
            }
            catch (Exception error) { Emit(new { ok = false, error = error.Message }); return 1; }
        }
        private static int Capture(string outputPath)
        {
            DesktopSession.RequireConsole();
            if (!Path.IsPathRooted(outputPath) || !string.Equals(Path.GetExtension(outputPath), ".png", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Absolute PNG output path required");
            if (File.Exists(outputPath)) throw new ArgumentException("Capture output already exists");
            Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
            int width = Native.GetSystemMetrics(0), height = Native.GetSystemMetrics(1);
            if (width < 1 || height < 1 || (long)width * height > 100000000) throw new InvalidOperationException("Invalid primary display dimensions");
            DateTime capturedUtc;
            Native.Point cursor;
            using (System.Drawing.Bitmap bitmap = new System.Drawing.Bitmap(width, height, System.Drawing.Imaging.PixelFormat.Format32bppRgb))
            {
                using (System.Drawing.Graphics graphics = System.Drawing.Graphics.FromImage(bitmap))
                {
                    IntPtr screen = Native.GetDC(IntPtr.Zero);
                    if (screen == IntPtr.Zero) throw new InvalidOperationException("Cannot obtain primary screen DC");
                    IntPtr destination = graphics.GetHdc();
                    try {
                        // SRCCOPY | CAPTUREBLT; Graphics.CopyFromScreen rejects
                        // this valid Win32 combination as an undefined enum.
                        if (!Native.BitBlt(destination, 0, 0, width, height, screen, 0, 0, 0x40CC0020)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    } finally { graphics.ReleaseHdc(destination); Native.ReleaseDC(IntPtr.Zero, screen); }
                }
                capturedUtc = DateTime.UtcNow;
                Native.GetPhysicalCursorPos(out cursor);
                DesktopSession.RequireConsole();
                bitmap.Save(outputPath, System.Drawing.Imaging.ImageFormat.Png);
            }
            Emit(new { ok = true, path = Path.GetFullPath(outputPath), capturedUtc = capturedUtc.ToString("o"), display = "primary", left = 0, top = 0, width = width, height = height, currentSession = DesktopSession.CurrentId(), consoleSession = Native.WTSGetActiveConsoleSessionId(), cursor = new { x = cursor.X, y = cursor.Y }, cursorIncludedInImage = false, inputSent = false });
            return 0;
        }
    }
}
