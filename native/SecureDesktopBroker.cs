// MIT. Optional local SYSTEM broker. No arbitrary process, shell or file-write API.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using Microsoft.Win32.SafeHandles;

namespace OpenDesktopHid {
    internal sealed class ApprovedApplication { public string id {get;set;} public string path {get;set;} public string sha256 {get;set;} }
    internal sealed class SecureSettings { public string operatorSid {get;set;} public ApprovedApplication[] applications {get;set;} }
    internal static class SecureNative {
        [StructLayout(LayoutKind.Sequential)] internal struct SecurityAttributes { public int size; public IntPtr descriptor; public int inherit; }
        [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] internal struct Startup {
            public int size; public string reserved,desktop,title; public int x,y,width,height,xchars,ychars,fill,flags; public short show,reservedSize; public IntPtr reservedBytes,input,output,error;
        }
        [StructLayout(LayoutKind.Sequential)] internal struct StartupEx { public Startup startup; public IntPtr attributes; }
        [StructLayout(LayoutKind.Sequential)] internal struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
        [StructLayout(LayoutKind.Sequential,Pack=4)] internal struct TokenPrivilege { public uint count; public long luid; public uint attributes; }
        [StructLayout(LayoutKind.Sequential)] internal struct BasicLimits { public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint activeProcesses; public UIntPtr affinity; public uint priority,scheduling; }
        [StructLayout(LayoutKind.Sequential)] internal struct IoCounters { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
        [StructLayout(LayoutKind.Sequential)] internal struct ExtendedLimits { public BasicLimits basic; public IoCounters io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern SafePipeHandle CreateNamedPipe(string name,uint open,uint mode,uint instances,uint output,uint input,uint timeout,ref SecurityAttributes security);
        [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe,out uint pid);
        [DllImport("kernel32.dll",SetLastError=true)] internal static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
        [DllImport("advapi32.dll",SetLastError=true)] internal static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
        [DllImport("advapi32.dll",SetLastError=true)] internal static extern bool DuplicateTokenEx(IntPtr token,uint access,IntPtr attributes,int level,int type,out IntPtr duplicate);
        [DllImport("advapi32.dll",SetLastError=true)] internal static extern bool SetTokenInformation(IntPtr token,int type,ref uint value,int length);
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern bool LookupPrivilegeValue(string system,string name,out long luid);
        [DllImport("advapi32.dll",SetLastError=true)] internal static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref TokenPrivilege privileges,int size,IntPtr previous,IntPtr needed);
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern bool CreateProcessAsUser(IntPtr token,string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupEx startup,out ProcessInfo info);
        [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool CreatePipe(out SafeFileHandle read,out SafeFileHandle write,ref SecurityAttributes security,uint size);
        [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
        [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
        [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,UIntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
        [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] internal static extern IntPtr CreateJobObject(IntPtr security,string name);
        [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimits limits,uint length);
        [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
        [DllImport("kernel32.dll")] internal static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll")] internal static extern bool TerminateProcess(IntPtr process,uint code);
        [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("user32.dll",SetLastError=true)] internal static extern bool SetThreadDesktop(IntPtr desktop);
        [DllImport("user32.dll")] internal static extern IntPtr GetThreadDesktop(uint thread);
        [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
        [StructLayout(LayoutKind.Sequential)] internal struct CursorInfo {public uint size,flags;public IntPtr handle;public Native.Point position;}
        [StructLayout(LayoutKind.Sequential)] internal struct IconInfo { [MarshalAs(UnmanagedType.Bool)] public bool icon;public uint hotX,hotY;public IntPtr mask,color;}
        [DllImport("user32.dll")] internal static extern bool GetCursorInfo(ref CursorInfo info);
        [DllImport("user32.dll")] internal static extern bool GetIconInfo(IntPtr cursor,out IconInfo info);
        [DllImport("user32.dll")] internal static extern bool DrawIconEx(IntPtr dc,int x,int y,IntPtr icon,int width,int height,uint step,IntPtr brush,uint flags);
        [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr value);
        internal static void Check(bool success) { if(!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        internal static bool SystemIdentity() { return WindowsIdentity.GetCurrent().User.IsWellKnown(WellKnownSidType.LocalSystemSid); }
        internal static void EnablePrivilege(IntPtr token,string name) {long luid;Check(LookupPrivilegeValue(null,name,out luid));var privilege=new TokenPrivilege{count=1,luid=luid,attributes=2};Check(AdjustTokenPrivileges(token,false,ref privilege,0,IntPtr.Zero,IntPtr.Zero));if(Marshal.GetLastWin32Error()==1300)throw new IOException("Required service privilege unavailable: "+name);}
        internal static string Hash(string file) { using(var stream=File.OpenRead(file)) using(var hash=SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant(); }
        internal static NamedPipeServerStream SystemPipe(string name) {
            var security=new PipeSecurity();security.SetSecurityDescriptorSddlForm("D:P(A;;GA;;;SY)");byte[] bytes=security.GetSecurityDescriptorBinaryForm();GCHandle pinned=GCHandle.Alloc(bytes,GCHandleType.Pinned);
            try{var attributes=new SecurityAttributes{size=Marshal.SizeOf(typeof(SecurityAttributes)),descriptor=pinned.AddrOfPinnedObject()};var handle=CreateNamedPipe("\\\\.\\pipe\\"+name,0x40080003,8,1,65536,65536,0,ref attributes);if(handle.IsInvalid){handle.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}return new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);}finally{pinned.Free();}
        }
    }

    // This process is fixed to our own protected executable and the active console.
    // A SYSTEM-only private pipe crosses sessions; no handles are inherited.
    // A kill-on-close job contains the child and denies child-process creation.
    internal sealed class SecureSessionWorker : IDisposable {
        private IntPtr job,process; private Stream input,output; private uint session;private NamedPipeServerStream connection;
        internal SecureSessionWorker(uint target,string stopEventName) {
            if(!SecureNative.SystemIdentity() || target==0 || target!=Native.WTSGetActiveConsoleSessionId()) throw new IOException("Active console required");
            session=target; IntPtr primary=IntPtr.Zero,duplicate=IntPtr.Zero;
            try {
                SecureNative.Check(SecureNative.OpenProcessToken(Process.GetCurrentProcess().Handle,0x0002|0x0008|0x0080|0x0001|0x20,out primary));
                SecureNative.EnablePrivilege(primary,"SeTcbPrivilege");
                SecureNative.Check(SecureNative.DuplicateTokenEx(primary,0x000F01FF,IntPtr.Zero,2,1,out duplicate));
                SecureNative.Check(SecureNative.SetTokenInformation(duplicate,12,ref target,4));
                string pipeName="KVMMCPServer.SecureDesktop.Worker."+Guid.NewGuid().ToString("N");connection=SecureNative.SystemPipe(pipeName);
                var startup=new SecureNative.StartupEx();startup.startup.size=Marshal.SizeOf(typeof(SecureNative.Startup));startup.startup.desktop="winsta0\\Default";
                string executable=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"SecureDesktopBroker.exe");
                SecureNative.ProcessInfo info;
                string command="\""+executable+"\" --session-worker \""+stopEventName+"\" \""+pipeName+"\" "+Process.GetCurrentProcess().Id;
                SecureNative.Check(SecureNative.CreateProcessAsUser(duplicate,executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x08000000|4,IntPtr.Zero,AppDomain.CurrentDomain.BaseDirectory,ref startup,out info));
                process=info.process;
                try {
                    job=SecureNative.CreateJobObject(IntPtr.Zero,null); SecureNative.Check(job!=IntPtr.Zero);
                    var limits=new SecureNative.ExtendedLimits(); limits.basic.flags=0x2000|0x100|8; limits.basic.activeProcesses=1; limits.processMemory=new UIntPtr(512u*1024u*1024u);
                    SecureNative.Check(SecureNative.SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(SecureNative.ExtendedLimits))));
                    SecureNative.Check(SecureNative.AssignProcessToJobObject(job,process));
                    if(SecureNative.ResumeThread(info.thread)==uint.MaxValue) throw new Win32Exception();
                } finally {SecureNative.CloseHandle(info.thread);}
                var connected=connection.WaitForConnectionAsync();if(!connected.Wait(5000))throw new IOException("SYSTEM session helper did not connect");connected.GetAwaiter().GetResult();
                uint peer;SecureNative.Check(SecureNative.GetNamedPipeClientProcessId(connection.SafePipeHandle,out peer));if(peer!=info.pid)throw new IOException("SYSTEM helper identity mismatch");input=output=connection;
            } catch {Dispose();throw;}
            finally {
                if(duplicate!=IntPtr.Zero)SecureNative.CloseHandle(duplicate); if(primary!=IntPtr.Zero)SecureNative.CloseHandle(primary);
            }
        }
        internal bool Current {get{return session==Native.WTSGetActiveConsoleSessionId();}}
        internal Dictionary<string,object> Call(Dictionary<string,object> request) {SecureProtocol.WriteJson(input,request,3000);return SecureProtocol.ReadJson(output,12000);}
        internal byte[] Frame(bool cursor) {
            SecureProtocol.WriteJson(input,new {op="frame",includeCursor=cursor},3000); byte[] header=SecureProtocol.Read(output,64,5000);
            if(BitConverter.ToUInt32(header,0)!=0x31464355 || BitConverter.ToInt32(header,4)!=1 || BitConverter.ToUInt32(header,12)!=session)throw new IOException("Worker frame identity mismatch");
            int count=BitConverter.ToInt32(header,32); if(count<0 || count>SecureProtocol.MaxPixels) throw new IOException("Frame size limit");
            byte[] result=new byte[64+count]; Buffer.BlockCopy(header,0,result,0,64);
            if(count>0)Buffer.BlockCopy(SecureProtocol.Read(output,count,5000),0,result,64,count);
            return result;
        }
        public void Dispose() {
            if(job!=IntPtr.Zero){SecureNative.CloseHandle(job);job=IntPtr.Zero;}
            if(process!=IntPtr.Zero){SecureNative.TerminateProcess(process,1);SecureNative.CloseHandle(process);process=IntPtr.Zero;}
            if(connection!=null){connection.Dispose();connection=null;}input=output=null;
        }
    }

    internal sealed class SecureDesktopService : ServiceBase {
        private SecureSettings settings; private Thread listener; private volatile bool stopping; private NamedPipeServerStream active; private SecureSessionWorker worker; private DateTime lastWarning;private EventWaitHandle stopEvent;private string stopEventName;private uint ownerPid;private long ownerStarted;
        internal SecureDesktopService(){ServiceName=SecureProtocol.ServiceName;CanStop=true;AutoLog=true;}
        protected override void OnStart(string[] args) {
            if(!SecureNative.SystemIdentity())throw new IOException("SYSTEM service required");
            string expected=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"KVMMCPServer","SecureDesktop");
            if(!String.Equals(Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\'),expected,StringComparison.OrdinalIgnoreCase))throw new IOException("Protected installation path required");
            string config=Path.Combine(expected,"secure-desktop.json"); if(new FileInfo(config).Length>16384)throw new IOException("Configuration size limit");
            settings=SecureProtocol.Json.Deserialize<SecureSettings>(File.ReadAllText(config));
            var sid=new SecurityIdentifier(settings.operatorSid); if(!sid.IsAccountSid())throw new IOException("Operator account SID required");
            if(settings.applications==null || settings.applications.Length>32)throw new IOException("Application configuration required");
            foreach(var application in settings.applications){if(String.IsNullOrEmpty(application.id)||String.IsNullOrEmpty(application.path)||String.IsNullOrEmpty(application.sha256)||!Path.GetFullPath(application.path).StartsWith(expected+"\\",StringComparison.OrdinalIgnoreCase)||(File.GetAttributes(application.path)&FileAttributes.ReparsePoint)!=0)throw new IOException("Applications must be staged in the protected installation directory");}
            var security=new EventWaitHandleSecurity();security.SetOwner(new SecurityIdentifier("S-1-5-18"));security.SetAccessRuleProtection(true,false);security.AddAccessRule(new EventWaitHandleAccessRule(new SecurityIdentifier("S-1-5-18"),EventWaitHandleRights.FullControl,AccessControlType.Allow));security.AddAccessRule(new EventWaitHandleAccessRule(sid,EventWaitHandleRights.Synchronize,AccessControlType.Allow));
            stopEventName="Global\\KVMMCPServer.UacStop."+Guid.NewGuid().ToString("N");bool created;stopEvent=new EventWaitHandle(false,EventResetMode.AutoReset,stopEventName,out created,security);if(!created)throw new IOException("Stop event collision");
            listener=new Thread(Listen){IsBackground=true};listener.Start();
        }
        protected override void OnStop(){stopping=true;var pipe=active;if(pipe!=null)pipe.Dispose();if(worker!=null)worker.Dispose();if(listener!=null)listener.Join(2000);if(stopEvent!=null)stopEvent.Dispose();}
        private NamedPipeServerStream CreatePipe() {
            var security=new PipeSecurity();security.SetSecurityDescriptorSddlForm("D:P(A;;GA;;;SY)(A;;GRGW;;;"+settings.operatorSid+")");
            byte[] bytes=security.GetSecurityDescriptorBinaryForm();GCHandle pinned=GCHandle.Alloc(bytes,GCHandleType.Pinned);
            try { var attributes=new SecureNative.SecurityAttributes{size=Marshal.SizeOf(typeof(SecureNative.SecurityAttributes)),descriptor=pinned.AddrOfPinnedObject()};
                var handle=SecureNative.CreateNamedPipe("\\\\.\\pipe\\"+SecureProtocol.PipeName,0x40080003,8,1,65536,16384,0,ref attributes);
                if(handle.IsInvalid){handle.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}
                return new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);
            }finally{pinned.Free();}
        }
        private Dictionary<string,object> Authenticate(NamedPipeServerStream pipe) {
            uint pid;SecureNative.Check(SecureNative.GetNamedPipeClientProcessId(pipe.SafePipeHandle,out pid));
            using(var client=Process.GetProcessById((int)pid)) {
                if((uint)client.SessionId!=Native.WTSGetActiveConsoleSessionId() || client.SessionId==0)throw new IOException("Caller is not in the active physical console");
                IntPtr token;SecureNative.Check(SecureNative.OpenProcessToken(client.Handle,8,out token));
                try {using(var identity=new WindowsIdentity(token)){if(identity.User.Value!=settings.operatorSid)throw new IOException("Wrong operator SID");}}finally{SecureNative.CloseHandle(token);}
                uint after;SecureNative.Check(SecureNative.GetNamedPipeClientProcessId(pipe.SafePipeHandle,out after));if(after!=pid)throw new IOException("Caller changed");
                return new Dictionary<string,object>{{"pid",pid},{"started",client.StartTime.ToUniversalTime().Ticks}};
            }
        }
        private void Listen() {
            while(!stopping) {
                try {using(var pipe=CreatePipe()) {active=pipe;pipe.WaitForConnection();var caller=Authenticate(pipe);
                    var request=SecureProtocol.ReadJson(pipe,4000);string op=SecureProtocol.Text(request,"op");
                    if(op!="status"&&op!="inspect"&&op!="respond"&&op!="frame"&&op!="input"&&op!="attach")throw new IOException("Unsupported operation");
                    if(request.Count>(op=="respond"?5:op=="input"?4:op=="frame"?2:1))throw new IOException("Unexpected request fields");
                    try {
                        if(op=="attach"){
                            bool occupied=false;if(ownerPid!=0){try{using(var previous=Process.GetProcessById((int)ownerPid)){occupied=!previous.HasExited&&previous.StartTime.ToUniversalTime().Ticks==ownerStarted;}}catch(ArgumentException){}}
                            if(occupied&&(ownerPid!=Convert.ToUInt32(caller["pid"])||ownerStarted!=Convert.ToInt64(caller["started"])))throw new IOException("A different HID controller owns secure-desktop input");
                            ownerPid=Convert.ToUInt32(caller["pid"]);ownerStarted=Convert.ToInt64(caller["started"]);request=new Dictionary<string,object>{{"op","status"}};
                        }
                        if((op=="input"||op=="respond")&&(ownerPid!=Convert.ToUInt32(caller["pid"])||ownerStarted!=Convert.ToInt64(caller["started"])))throw new IOException("Only the registered HID controller can submit secure input");
                        if(worker==null || !worker.Current){if(worker!=null)worker.Dispose();worker=new SecureSessionWorker(Native.WTSGetActiveConsoleSessionId(),stopEventName);}
                        if(op=="frame"){object raw;bool cursor=!request.TryGetValue("includeCursor",out raw)||raw is bool&&(bool)raw;SecureProtocol.Write(pipe,worker.Frame(cursor),5000);continue;}
                        if(op=="respond") {
                            string decision=SecureProtocol.Text(request,"decision"),id=SecureProtocol.Text(request,"applicationId");
                            if(decision!="approve"&&decision!="deny")throw new IOException("Invalid decision");
                            var app=settings.applications.SingleOrDefault(item=>item.id==id);
                            if(decision=="approve" && app==null)throw new IOException("Application is not operator-approved");
                            object deadline;request.TryGetValue("deadlineUtcMs",out deadline);
                            request=new Dictionary<string,object>{{"op",op},{"decision",decision},{"promptId",SecureProtocol.Text(request,"promptId")},{"application",app},{"deadlineUtcMs",deadline}};
                        }
                        if(op=="input"){object deadline;request.TryGetValue("deadlineUtcMs",out deadline);request=new Dictionary<string,object>{{"op","respond"},{"decision","click"},{"promptId",SecureProtocol.Text(request,"promptId")},{"report",SecureProtocol.Text(request,"report")},{"applications",settings.applications},{"deadlineUtcMs",deadline}};}
                        if(op=="input"||op=="respond"){
                            long now=(DateTime.UtcNow.Ticks-621355968000000000L)/10000;object deadline;request.TryGetValue("deadlineUtcMs",out deadline);long expires=deadline==null?now+5000:Convert.ToInt64(deadline);
                            if(expires<=now||expires>now+60000)throw new IOException("Input authorization expired or exceeds a short lease");
                            request["deadlineUtcMs"]=Math.Min(expires,now+5000);request["budgetMs"]=Math.Min(5000,expires-now);request["clientPid"]=caller["pid"];request["clientStarted"]=caller["started"];
                        }
                        var reply=worker.Call(request);if(op=="status"||op=="attach"){reply["applications"]=settings.applications;reply["networkListener"]=false;}if((op=="input"||op=="respond")&&SecureProtocol.Text(reply,"decision")!="motion"){object ok;if(reply.TryGetValue("ok",out ok)&&ok is bool&&(bool)ok){try{EventLog.WriteEntry(ServiceName,"UAC "+SecureProtocol.Text(reply,"decision")+"; operator="+settings.operatorSid+"; clientPid="+caller["pid"]+"; applicationId="+SecureProtocol.Text(reply,"applicationId"),EventLogEntryType.Information);}catch{}}}SecureProtocol.WriteJson(pipe,reply,5000);
                    }catch(Exception error) {if(worker!=null){worker.Dispose();worker=null;}if(op=="frame")SecureProtocol.Write(pipe,SecureDesktopWorker.ErrorFrame(),3000);else SecureProtocol.WriteJson(pipe,new{ok=false,error=error.Message},3000);}
                }}catch(Exception error){if(!stopping){if(DateTime.UtcNow-lastWarning>TimeSpan.FromSeconds(10)){try{EventLog.WriteEntry(ServiceName,error.Message,EventLogEntryType.Warning);}catch{}lastWarning=DateTime.UtcNow;}Thread.Sleep(100);}}finally{active=null;}
            }
        }
    }

    internal static class SecureDesktopWorker {
        private static string promptId;private static uint promptPid;private static long promptTicks;private static IntPtr promptWindow;private static DateTime promptExpires;private static bool inputAttempted;private static EventWaitHandle stopEvent;private static string stopEventName;private static long requestStarted,stopEpoch,promptEpoch;
        private static void ConsoleOnly(){if(!SecureNative.SystemIdentity() || (uint)Process.GetCurrentProcess().SessionId!=Native.WTSGetActiveConsoleSessionId())throw new IOException("SYSTEM in active console required");}
        private static object OnInputDesktop(Func<object> action) {
            object result=null;Exception failure=null;
            var thread=new Thread(delegate(){IntPtr desktop=IntPtr.Zero,previous=SecureNative.GetThreadDesktop(SecureNative.GetCurrentThreadId());try{
                ConsoleOnly();desktop=Native.OpenInputDesktop(0,false,0x1ff);if(desktop==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
                SecureNative.Check(SecureNative.SetThreadDesktop(desktop));result=action();
            }catch(Exception error){failure=error;}finally{SecureNative.SetThreadDesktop(previous);if(desktop!=IntPtr.Zero)Native.CloseDesktop(desktop);}});
            thread.IsBackground=true;thread.SetApartmentState(ApartmentState.MTA);thread.Start();
            if(!thread.Join(10000)){Environment.Exit(2);throw new IOException("Secure desktop operation timed out");}if(failure!=null)throw failure;return result;
        }
        private static Process Consent(out IntPtr window) {
            ConsoleOnly();if(DesktopSession.InputDesktopName()!="Winlogon")throw new IOException("No UAC secure desktop");
            window=SecureNative.GetForegroundWindow();uint pid;SecureNative.GetWindowThreadProcessId(window,out pid);if(pid==0)throw new IOException("No foreground consent dialog");
            var process=Process.GetProcessById((int)pid);
            try {
                string expected=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","consent.exe");
                if(!String.Equals(process.MainModule.FileName,expected,StringComparison.OrdinalIgnoreCase)||(uint)process.SessionId!=Native.WTSGetActiveConsoleSessionId())throw new IOException("Foreground window is not Windows consent.exe");
                IntPtr token;SecureNative.Check(SecureNative.OpenProcessToken(process.Handle,8,out token));try{using(var identity=new WindowsIdentity(token)){if(!identity.User.IsWellKnown(WellKnownSidType.LocalSystemSid))throw new IOException("Consent owner mismatch");}}finally{SecureNative.CloseHandle(token);}
                return process;
            }catch{process.Dispose();throw;}
        }
        private static AutomationElementCollection Elements(IntPtr window){return AutomationElement.FromHandle(window).FindAll(TreeScope.Descendants,Condition.TrueCondition);}
        private static string[] Names(AutomationElementCollection elements) {
            var names=new List<string>();foreach(AutomationElement item in elements){if(names.Count>=256)break;if(item.Current.IsPassword)continue;string name=item.Current.Name;if(!String.IsNullOrEmpty(name)&&name.Length<=1024)names.Add(name);
                object value;if(item.TryGetCurrentPattern(ValuePattern.Pattern,out value)){string text=((ValuePattern)value).Current.Value;if(!String.IsNullOrEmpty(text)&&text.Length<=1024)names.Add(text);}}
            return names.Distinct().ToArray();
        }
        private static bool MatchesPath(string text,string path) {
            string value=text.Trim();foreach(string prefix in new[]{"Program location:","Programmalocatie:","Location:"})if(value.StartsWith(prefix,StringComparison.OrdinalIgnoreCase))value=value.Substring(prefix.Length).Trim();
            return String.Equals(value.Trim('"'),path,StringComparison.OrdinalIgnoreCase);
        }
        // Never search arbitrary dialog text for an executable path: an
        // unapproved program can spoof its own display name/file description.
        // Only Microsoft consent's semantic location/command-line fields or an
        // explicit UIA LabeledBy relationship qualify. Unknown layouts fail closed.
        private static string[] ProgramLocations(AutomationElementCollection elements) {
            var paths=new List<string>();
            foreach(AutomationElement item in elements){if(item.Current.IsPassword)continue;string id=item.Current.AutomationId;
                bool field=new[]{"ProgramLocation","ProgramLocationText","ProgramPath","CommandLine","CommandLineText"}.Any(value=>String.Equals(value,id,StringComparison.OrdinalIgnoreCase));
                if(item.Current.ControlType==ControlType.Text&&SecureConsentProfile.ExpandedLocation(id,item.Current.Name))field=true;
                var label=item.Current.LabeledBy;
                if(label!=null&&!String.IsNullOrEmpty(label.Current.AutomationId)&&label.Current.ControlType==ControlType.Text&&new[]{"Program location:","Programmalocatie:","Program path:","Programmapad:"}.Contains(label.Current.Name.Trim()))field=true;
                if(!field)continue;string text=item.Current.Name;if(!String.IsNullOrEmpty(text)&&text.Length<=2048)paths.Add(text);object raw;if(item.TryGetCurrentPattern(ValuePattern.Pattern,out raw)){text=((ValuePattern)raw).Current.Value;if(!String.IsNullOrEmpty(text)&&text.Length<=2048)paths.Add(text);}
            }
            return paths.Distinct().ToArray();
        }
        private static object[] AccessibleFields(AutomationElementCollection elements) {
            var result=new List<object>();foreach(AutomationElement item in elements){if(result.Count>=80)break;if(item.Current.IsPassword)continue;string name=item.Current.Name;if(name!=null&&name.Length>512)name=name.Substring(0,512);var label=item.Current.LabeledBy;result.Add(new{name=name,id=item.Current.AutomationId,type=item.Current.ControlType.ProgrammaticName,labeledBy=label==null?null:label.Current.AutomationId});}return result.ToArray();
        }
        private static void TrackPrompt(Process consent,IntPtr window) {
            long epoch=Interlocked.Read(ref stopEpoch);if(promptId==null||promptPid!=(uint)consent.Id||promptTicks!=consent.StartTime.ToUniversalTime().Ticks||promptWindow!=window||DateTime.UtcNow>promptExpires||promptEpoch!=epoch){promptId=Guid.NewGuid().ToString();promptPid=(uint)consent.Id;promptTicks=consent.StartTime.ToUniversalTime().Ticks;promptWindow=window;promptEpoch=epoch;}
            promptExpires=DateTime.UtcNow.AddSeconds(30);
        }
        private static Dictionary<string,object> Inspect(bool details) {
            IntPtr window;using(var consent=Consent(out window)) {
                var elements=Elements(window);
                if(details){foreach(AutomationElement item in elements){string name=item.Current.Name;if(!item.Current.IsOffscreen&&(name.Equals("Show more details",StringComparison.OrdinalIgnoreCase)||name.Equals("Meer details weergeven",StringComparison.OrdinalIgnoreCase))){object pattern;if(item.TryGetCurrentPattern(InvokePattern.Pattern,out pattern)){((InvokePattern)pattern).Invoke();Thread.Sleep(150);elements=Elements(window);}break;}}}
                TrackPrompt(consent,window);
                return new Dictionary<string,object>{{"ok",true},{"desktop","Winlogon"},{"session",consent.SessionId},{"promptId",promptId},{"consentPid",consent.Id},{"expiresUtc",promptExpires.ToString("o")},{"details",Names(elements)},{"fields",AccessibleFields(elements)},{"programLocations",ProgramLocations(elements)}};
            }
        }
        private static Dictionary<string,object> Respond(Dictionary<string,object> request) {
            string challenge=SecureProtocol.Text(request,"promptId"),decision=SecureProtocol.Text(request,"decision"),applicationId=null;
            if(!SecureConsentProfile.SamePrompt(challenge,promptId)||DateTime.UtcNow>promptExpires)throw new IOException("Stale or unknown UAC prompt; inspect again");
            request["stopEpoch"]=promptEpoch;
            IntPtr window;using(var consent=Consent(out window)) {
                if(promptPid!=(uint)consent.Id||promptTicks!=consent.StartTime.ToUniversalTime().Ticks||window!=promptWindow)throw new IOException("UAC prompt changed");
                var elements=Elements(window);var locations=ProgramLocations(elements);
                foreach(AutomationElement item in elements)if(item.Current.IsPassword)throw new IOException("Credential prompts are not supported");
                byte[] requested=null;double requestedX=0,requestedY=0;
                if(decision=="click") {
                    requested=Wire.Decode(SecureProtocol.Text(request,"report"));
                    if((requested[0]!=3&&requested[0]!=4)||requested[1]>1||requested[requested.Length-1]!=0)throw new IOException("Only mouse motion and a left consent click are supported");
                    if(requested[1]==0){using(var mutex=new Mutex(false,"Local\\OpenDesktopHID-vmulti")){bool held=false;try{try{held=mutex.WaitOne(1000);}catch(AbandonedMutexException){held=true;}if(!held)throw new IOException("Desktop busy");InputAuthority(request);using(var device=new Device()){try{inputAttempted=true;device.Send(requested);}finally{device.Release();}}}finally{if(held)mutex.ReleaseMutex();}}return new Dictionary<string,object>{{"ok",true},{"inputSent",true},{"decision","motion"}};}
                    if(requested[0]!=3)throw new IOException("Use an absolute mouse click for UAC consent");
                    requestedX=(requested[2]+256*requested[3])*(Native.GetSystemMetrics(0)-1)/32767.0;requestedY=(requested[4]+256*requested[5])*(Native.GetSystemMetrics(1)-1)/32767.0;
                    AutomationElement target=null;
                    foreach(AutomationElement item in elements){var bounds=item.Current.BoundingRectangle;if(IsAction(item)&&!item.Current.IsOffscreen&&item.Current.IsEnabled&&bounds.Contains(requestedX,requestedY)){target=item;break;}}
                    if(target==null)throw new IOException("Click is outside a recognized UAC button");
                    string label=target.Current.Name;
                    if(new[]{"Yes","Ja"}.Contains(label))decision="approve";
                    else if(new[]{"No","Nee","Cancel","Annuleren"}.Contains(label))decision="deny";
                    else if(SecureConsentProfile.DetailsLabels.Contains(label))decision="details";
                    else throw new IOException("This UAC control cannot be operated");
                    if(decision=="approve"){
                        object rawApps;request.TryGetValue("applications",out rawApps);
                        var apps=SecureProtocol.Json.ConvertToType<ApprovedApplication[]>(rawApps);
                        var matching=apps.Where(app=>locations.Any(location=>MatchesPath(location,app.path))).ToArray();
                        if(matching.Length!=1)throw new IOException("Show the executable location; this application must be explicitly operator-approved");
                        applicationId=matching[0].id;
                        request["application"]=new Dictionary<string,object>{{"path",matching[0].path},{"sha256",matching[0].sha256}};
                    }
                }
                if(decision=="approve") {
                    object raw;request.TryGetValue("application",out raw);var app=raw as Dictionary<string,object>;
                    if(app==null)throw new IOException("Approved application is missing");
                    string path=SecureProtocol.Text(app,"path"),sha=SecureProtocol.Text(app,"sha256");
                    if(String.IsNullOrEmpty(path)||String.IsNullOrEmpty(sha)||!Path.IsPathRooted(path)||(File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0||SecureNative.Hash(path)!=sha.ToLowerInvariant())throw new IOException("Approved executable hash mismatch");
                    if(!locations.Any(location=>MatchesPath(location,path)))throw new IOException("UAC executable location field is unavailable or does not match the approved application");
                }
                AutomationElement button=null;
                string[] accepted=decision=="approve"?new[]{"Yes","Ja"}:decision=="details"?SecureConsentProfile.DetailsLabels:new[]{"No","Nee","Cancel","Annuleren"};
                foreach(AutomationElement item in elements)if(IsAction(item)&&!item.Current.IsOffscreen&&item.Current.IsEnabled&&accepted.Contains(item.Current.Name)){button=item;break;}
                if(button==null)throw new IOException("Identified consent button is unavailable");
                var rectangle=button.Current.BoundingRectangle;int width=Native.GetSystemMetrics(0),height=Native.GetSystemMetrics(1);double x=rectangle.X+rectangle.Width/2,y=rectangle.Y+rectangle.Height/2;
                if(width<2||height<2||x<0||y<0||x>=width||y>=height)throw new IOException("Consent button is outside the primary monitor");
                using(var mutex=new Mutex(false,"Local\\OpenDesktopHID-vmulti")){
                    bool owned=false;try{try{owned=mutex.WaitOne(4000);}catch(AbandonedMutexException){owned=true;}if(!owned)throw new IOException("Normal HID helper has not released control");
                        using(var device=new Device()){
                            ushort ax=(ushort)Math.Round(x*32767/(width-1)),ay=(ushort)Math.Round(y*32767/(height-1));byte[] report={3,0,(byte)ax,(byte)(ax>>8),(byte)ay,(byte)(ay>>8),0};
                            try{InputAuthority(request);device.Release();inputAttempted=true;device.Send(report);Thread.Sleep(60);IntPtr current;using(var again=Consent(out current)){if(current!=window||again.Id!=consent.Id||again.StartTime.ToUniversalTime().Ticks!=promptTicks)throw new IOException("UAC prompt changed before input");}
                                InputAuthority(request);promptId=null;report[1]=1;device.Send(report);Thread.Sleep(40);report[1]=0;device.Send(report);
                            }finally{device.Release();}
                        }
                    }finally{if(owned)mutex.ReleaseMutex();}
                }
                return new Dictionary<string,object>{{"ok",true},{"decision",decision},{"applicationId",applicationId},{"consentPid",consent.Id},{"inputSent",true},{"backend","vhf-hid"}};
            }
        }
        private static bool IsAction(AutomationElement item) {return item.Current.ControlType==ControlType.Button||(item.Current.ControlType==ControlType.Hyperlink&&item.Current.AutomationId=="ShowHideDetails"&&SecureConsentProfile.DetailsLabels.Contains(item.Current.Name));}
        private static void InputAuthority(Dictionary<string,object> request) {
            long deadline=Convert.ToInt64(request["deadlineUtcMs"]),now=(DateTime.UtcNow.Ticks-621355968000000000L)/10000;
            if(now>=deadline)throw new IOException("Input authorization expired");
            if(Convert.ToInt64(request["stopEpoch"])!=Interlocked.Read(ref stopEpoch))throw new IOException("Local operator revoked this UAC frame");
            if((Stopwatch.GetTimestamp()-requestStarted)*1000.0/Stopwatch.Frequency>=Convert.ToInt64(request["budgetMs"]))throw new IOException("Input authorization elapsed");
            using(var client=Process.GetProcessById(Convert.ToInt32(request["clientPid"])))if(client.HasExited||client.StartTime.ToUniversalTime().Ticks!=Convert.ToInt64(request["clientStarted"])||(uint)client.SessionId!=Native.WTSGetActiveConsoleSessionId())throw new IOException("Input owner disconnected");
            if((Native.GetAsyncKeyState(0x11)&0x8000)!=0&&(Native.GetAsyncKeyState(0x12)&0x8000)!=0&&(Native.GetAsyncKeyState(0x7b)&0x8000)!=0)throw new IOException("Local operator emergency hotkey");
        }
        internal static byte[] ErrorFrame(){var bytes=new byte[64];Buffer.BlockCopy(BitConverter.GetBytes(0x31464355),0,bytes,0,4);Buffer.BlockCopy(BitConverter.GetBytes(1),0,bytes,4,4);Buffer.BlockCopy(BitConverter.GetBytes(1),0,bytes,8,4);Buffer.BlockCopy(BitConverter.GetBytes((uint)Process.GetCurrentProcess().SessionId),0,bytes,12,4);return bytes;}
        private static byte[] Frame(bool includeCursor) {
            ConsoleOnly();string desktop=DesktopSession.InputDesktopName();if(desktop!="Default"&&desktop!="Winlogon")throw new IOException("Unsupported desktop");
            if(desktop=="Winlogon"){IntPtr window;using(var consent=Consent(out window)){TrackPrompt(consent,window);} }
            int width=Native.GetSystemMetrics(0),height=Native.GetSystemMetrics(1);long count=(long)width*height*4;
            if(width<1||height<1||count>SecureProtocol.MaxPixels)throw new IOException("Frame dimension limit");
            byte[] result=new byte[64+(int)count];Native.Point cursor;Native.GetPhysicalCursorPos(out cursor);
            bool cursorIncluded=false;
            using(var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
                using(var graphics=Graphics.FromImage(bitmap)){IntPtr destination=graphics.GetHdc(),source=Native.GetDC(IntPtr.Zero);try{SecureNative.Check(Native.BitBlt(destination,0,0,width,height,source,0,0,0x40CC0020));}finally{Native.ReleaseDC(IntPtr.Zero,source);graphics.ReleaseHdc(destination);}}
                if(includeCursor){var pointer=new SecureNative.CursorInfo{size=(uint)Marshal.SizeOf(typeof(SecureNative.CursorInfo))};if(SecureNative.GetCursorInfo(ref pointer)&&(pointer.flags&1)!=0){SecureNative.IconInfo icon;if(SecureNative.GetIconInfo(pointer.handle,out icon)){try{using(var graphics=Graphics.FromImage(bitmap)){IntPtr dc=graphics.GetHdc();try{cursorIncluded=SecureNative.DrawIconEx(dc,pointer.position.X-(int)icon.hotX,pointer.position.Y-(int)icon.hotY,pointer.handle,0,0,0,IntPtr.Zero,3);}finally{graphics.ReleaseHdc(dc);}}}finally{if(icon.mask!=IntPtr.Zero)SecureNative.DeleteObject(icon.mask);if(icon.color!=IntPtr.Zero)SecureNative.DeleteObject(icon.color);}}}}
                var data=bitmap.LockBits(new Rectangle(0,0,width,height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);try{for(int row=0;row<height;row++)Marshal.Copy(IntPtr.Add(data.Scan0,row*data.Stride),result,64+row*width*4,width*4);}finally{bitmap.UnlockBits(data);}
            }
            if(DesktopSession.InputDesktopName()!=desktop)throw new IOException("Desktop changed during capture");
            using(var stream=new MemoryStream(result,0,64,true))using(var writer=new BinaryWriter(stream)){writer.Write(0x31464355);writer.Write(1);writer.Write(0);writer.Write((uint)Process.GetCurrentProcess().SessionId);writer.Write(width);writer.Write(height);writer.Write(cursor.X);writer.Write(cursor.Y);writer.Write((int)count);writer.Write((desktop=="Winlogon"?2:1)|(cursorIncluded?256:0));writer.Write(DateTime.UtcNow.ToFileTimeUtc());writer.Write(desktop=="Winlogon"?new Guid(promptId).ToByteArray():Guid.Empty.ToByteArray());}
            return result;
        }
        internal static int Run(string eventName,Stream input,Stream output) {
            ConsoleOnly();Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
            if(eventName==null||!eventName.StartsWith("Global\\KVMMCPServer.UacStop.",StringComparison.Ordinal)||eventName.Length>100)throw new IOException("Invalid service stop event");stopEventName=eventName;stopEvent=EventWaitHandle.OpenExisting(eventName,EventWaitHandleRights.Modify|EventWaitHandleRights.Synchronize);
            var watchdog=new Thread(delegate(){IntPtr previous=SecureNative.GetThreadDesktop(SecureNative.GetCurrentThreadId());bool wasDown=false;for(;;){IntPtr desktop=IntPtr.Zero;try{desktop=Native.OpenInputDesktop(0,false,0x1ff);bool down=desktop!=IntPtr.Zero&&SecureNative.SetThreadDesktop(desktop)&&DesktopSession.InputDesktopName()=="Winlogon"&&(Native.GetAsyncKeyState(0x11)&0x8000)!=0&&(Native.GetAsyncKeyState(0x12)&0x8000)!=0&&(Native.GetAsyncKeyState(0x7b)&0x8000)!=0;if(down&&!wasDown){Interlocked.Increment(ref stopEpoch);stopEvent.Set();}wasDown=down;}catch{}finally{SecureNative.SetThreadDesktop(previous);if(desktop!=IntPtr.Zero)Native.CloseDesktop(desktop);}Thread.Sleep(100);}}){IsBackground=true};watchdog.Start();
            for(;;){Dictionary<string,object> request;try{request=SecureProtocol.ReadJson(input,0);}catch(EndOfStreamException){return 0;}
                string op=SecureProtocol.Text(request,"op");inputAttempted=false;requestStarted=Stopwatch.GetTimestamp();try {
                    if(op=="frame"){object raw;bool cursor=!request.TryGetValue("includeCursor",out raw)||raw is bool&&(bool)raw;SecureProtocol.Write(output,(byte[])OnInputDesktop(()=>Frame(cursor)),5000);continue;}
                    object reply=OnInputDesktop(delegate(){if(op=="status")return new{ok=true,desktop=DesktopSession.InputDesktopName(),session=Process.GetCurrentProcess().SessionId,system=true,stopEventName=stopEventName};if(op=="inspect")return Inspect(true);if(op=="respond")return Respond(request);throw new IOException("Unsupported worker operation");});
                    SecureProtocol.WriteJson(output,reply,5000);
                }catch(Exception error){if(op=="frame")SecureProtocol.Write(output,ErrorFrame(),5000);else SecureProtocol.WriteJson(output,new{ok=false,error=error.Message,inputSent=inputAttempted,policyRefusal=!inputAttempted},5000);}
            }
        }
    }
    internal static class SecureConsentProfile {
        internal static readonly string[] DetailsLabels={"Show more details","Meer details weergeven","Show fewer details","Minder details weergeven","Hide details","Details verbergen"};
        internal static bool SamePrompt(string first,string second){Guid a,b;return Guid.TryParse(first,out a)&&Guid.TryParse(second,out b)&&a!=Guid.Empty&&a==b;}
        // Observed Windows 11 consent.exe field, never ProgramName/publisher text.
        internal static bool ExpandedLocation(string id,string name){return id=="ExpandedTextLine"&&name!=null&&new[]{"Program location:","Programmalocatie:"}.Any(prefix=>name.StartsWith(prefix,StringComparison.Ordinal));}
    }
    internal static class SecureDesktopProgram {
        private static int Main(string[] args) {
            try {
                if(args.Length==4&&args[0]=="--session-worker"){if(!SecureNative.SystemIdentity())throw new IOException("SYSTEM helper required");uint expected;if(!UInt32.TryParse(args[3],out expected))throw new IOException("Invalid service identity");using(var pipe=SecureDesktopClient.ConnectWorker(args[2],expected)){return SecureDesktopWorker.Run(args[1],pipe,pipe);}}
                if(args.Length==1&&args[0]=="--service"){ServiceBase.Run(new SecureDesktopService());return 0;}
                if(args.Length==1&&args[0]=="status"){Console.WriteLine(SecureProtocol.Json.Serialize(SecureDesktopClient.Call(new{op="status"})));return 0;}
                if(args.Length==1&&args[0]=="inspect"){Console.WriteLine(SecureProtocol.Json.Serialize(SecureDesktopClient.Call(new{op="inspect"})));return 0;}
                if(args.Length==1&&args[0]=="frame"){using(var pipe=SecureDesktopClient.Connect()){SecureProtocol.WriteJson(pipe,new{op="frame",includeCursor=true},3000);byte[] header=SecureProtocol.Read(pipe,64,5000);int length=BitConverter.ToInt32(header,32);if(BitConverter.ToInt32(header,0)!=0x31464355||BitConverter.ToInt32(header,8)!=0||length<1||length>SecureProtocol.MaxPixels)throw new IOException("Frame unavailable");var output=Console.OpenStandardOutput();SecureProtocol.Write(output,header,5000);SecureProtocol.Write(output,SecureProtocol.Read(pipe,length,5000),5000);}return 0;}
                if(args.Length==1&&args[0]=="self-test"){
                    if(!SecureConsentProfile.SamePrompt("5CD3AA2D-A453-4DCB-8934-141C34D73247","5cd3aa2d-a453-4dcb-8934-141c34d73247")||SecureConsentProfile.SamePrompt(null,null)||SecureConsentProfile.SamePrompt(Guid.Empty.ToString(),Guid.Empty.ToString())||SecureConsentProfile.SamePrompt(Guid.NewGuid().ToString(),Guid.NewGuid().ToString()))throw new Exception("Prompt identity normalization failed");
                    if(!SecureConsentProfile.ExpandedLocation("ExpandedTextLine","Program location: \"C:\\protected.exe\"")||SecureConsentProfile.ExpandedLocation("ProgramName","Program location: \"C:\\protected.exe\"")||SecureConsentProfile.ExpandedLocation("ExpandedTextLine","Untrusted display name"))throw new Exception("Consent location profile failed");
                    if(SecureProtocol.MaxPixels!=67108864||SecureProtocol.Text(new Dictionary<string,object>{{"a","b"}},"a")!="b")throw new Exception("Protocol constants");
                    if(Marshal.SizeOf(typeof(SecureNative.TokenPrivilege))!=16||Marshal.SizeOf(typeof(SecureNative.StartupEx))!=112||Marshal.SizeOf(typeof(SecureNative.ExtendedLimits))!=144)throw new Exception("x64 Windows ABI mismatch");
                    var settings=SecureProtocol.Json.Deserialize<SecureSettings>("{\"operatorSid\":\"S-1-5-21-1-2-3-1000\",\"applications\":[{\"id\":\"probe\",\"path\":\"C:\\\\Program Files\\\\test.exe\",\"sha256\":\"abc\"}]}");if(settings.applications.Length!=1||settings.applications[0].id!="probe")throw new Exception("Configuration deserialization failed");
                    using(var stream=new MemoryStream()){SecureProtocol.WriteJson(stream,new{op="status"},0);stream.Position=0;if(SecureProtocol.Text(SecureProtocol.ReadJson(stream,0),"op")!="status")throw new Exception("Protocol roundtrip");}
                    foreach(int length in new[]{-1,0,1,SecureProtocol.MaxJson+1}){using(var stream=new MemoryStream(BitConverter.GetBytes(length))){bool refused=false;try{SecureProtocol.ReadJson(stream,0);}catch(IOException){refused=true;}if(!refused)throw new Exception("Invalid length accepted");}}
                    Console.WriteLine("{\"ok\":true,\"serviceStarted\":false,\"inputSent\":false}");return 0;
                }
                throw new ArgumentException("Use --service, status, or self-test");
            }catch(Exception error){Console.Error.WriteLine(error.Message);return 1;}
        }
    }
}
