// MIT. Fixed local IPC; clients never impersonate the privileged server.
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading.Tasks;
using System.Threading;
using System.Security.AccessControl;
using System.Web.Script.Serialization;
using System.Collections.Generic;
namespace OpenDesktopHid {
    internal sealed class SecurePolicyException : IOException { internal SecurePolicyException(string message):base(message){} }
    internal static class SecureProtocol {
        internal const string ServiceName = "KVMMCPServerSecureDesktop";
        internal const string PipeName = "KVMMCPServer.SecureDesktop.v1";
        internal const int MaxJson = 65536, MaxPixels = 64 * 1024 * 1024;
        internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxJson, RecursionLimit = 12 };
        internal static byte[] Read(Stream stream, int count, int timeout) {
            if (count < 0 || count > MaxPixels) throw new IOException("IPC size limit");
            byte[] bytes = new byte[count]; int at = 0;
            while (at < count) {
                Task<int> task = stream.ReadAsync(bytes, at, count-at);
                if (timeout > 0 && !task.Wait(timeout)) throw new IOException("IPC read timeout");
                int read = task.GetAwaiter().GetResult();
                if (read == 0) throw new EndOfStreamException(); at += read;
            }
            return bytes;
        }
        internal static void Write(Stream stream, byte[] bytes, int timeout) {
            Task task = stream.WriteAsync(bytes,0,bytes.Length);
            if (timeout > 0 && !task.Wait(timeout)) throw new IOException("IPC write timeout");
            task.GetAwaiter().GetResult(); stream.Flush();
        }
        internal static Dictionary<string,object> ReadJson(Stream stream, int timeout) {
            int length=BitConverter.ToInt32(Read(stream,4,timeout),0);
            if(length<2 || length>MaxJson) throw new IOException("JSON size limit");
            return Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(Read(stream,length,timeout)));
        }
        internal static void WriteJson(Stream stream, object value, int timeout) {
            byte[] bytes=Encoding.UTF8.GetBytes(Json.Serialize(value));
            if(bytes.Length>MaxJson) throw new IOException("JSON size limit");
            Write(stream,BitConverter.GetBytes(bytes.Length),timeout); Write(stream,bytes,timeout);
        }
        internal static string Text(Dictionary<string,object> value,string key) { object result; return value.TryGetValue(key,out result) ? result as string : null; }
    }
    internal static class SecureDesktopClient {
        private static EventWaitHandle stopEvent;private static uint monitorServerPid;
        internal static bool EnableStopMonitor() {
            try { var status=Call(new{op="attach"});string name=SecureProtocol.Text(status,"stopEventName");if(name==null||!name.StartsWith("Global\\KVMMCPServer.UacStop.",StringComparison.Ordinal)||name.Length>100)return false;stopEvent=EventWaitHandle.OpenExisting(name,EventWaitHandleRights.Synchronize);monitorServerPid=ServerPid();return monitorServerPid!=0; }catch{return false;}
        }
        internal static bool StopRequested(){return stopEvent!=null&&(stopEvent.WaitOne(0)||ServerPid()!=monitorServerPid);}
        [StructLayout(LayoutKind.Sequential)] private struct ServiceStatus { public uint type,state,controls,exit,specific,checkpoint,waitHint,pid,flags; }
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr OpenSCManager(string machine,string database,uint access);
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr OpenService(IntPtr manager,string name,uint access);
        [DllImport("advapi32.dll")] private static extern bool QueryServiceStatusEx(IntPtr service,int level,ref ServiceStatus value,int size,out int needed);
        [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);
        [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe,out uint pid);
        internal static bool Available() { try { return ServerPid()!=0; } catch { return false; } }
        private static uint ServerPid() {
            IntPtr manager=OpenSCManager(null,null,1); if(manager==IntPtr.Zero) return 0;
            try { IntPtr service=OpenService(manager,SecureProtocol.ServiceName,4); if(service==IntPtr.Zero) return 0;
                try { ServiceStatus status=new ServiceStatus(); int needed; return QueryServiceStatusEx(service,0,ref status,Marshal.SizeOf(typeof(ServiceStatus)),out needed) && status.state==4 ? status.pid : 0; }
                finally {CloseServiceHandle(service);}
            } finally {CloseServiceHandle(manager);}
        }
        internal static NamedPipeClientStream Connect() {
            uint expected=ServerPid(); if(expected==0) throw new IOException("Secure desktop service is unavailable");
            var pipe=new NamedPipeClientStream(".",SecureProtocol.PipeName,PipeDirection.InOut,PipeOptions.Asynchronous,TokenImpersonationLevel.Identification);
            try { pipe.Connect(1500); uint actual;
                if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle,out actual) || actual!=expected || ServerPid()!=actual) throw new IOException("Secure pipe server identity mismatch");
                return pipe;
            } catch {pipe.Dispose();throw;}
        }
        internal static NamedPipeClientStream ConnectWorker(string name,uint expected) {
            if(!name.StartsWith("KVMMCPServer.SecureDesktop.Worker.",StringComparison.Ordinal)||name.Length>100||expected==0||ServerPid()!=expected)throw new IOException("Invalid SYSTEM worker endpoint");
            var pipe=new NamedPipeClientStream(".",name,PipeDirection.InOut,PipeOptions.Asynchronous,TokenImpersonationLevel.Identification);
            try{pipe.Connect(5000);uint actual;if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle,out actual)||actual!=expected||ServerPid()!=actual)throw new IOException("SYSTEM worker server identity mismatch");return pipe;}catch{pipe.Dispose();throw;}
        }
        internal static Dictionary<string,object> Call(object request) {
            using(var pipe=Connect()) { SecureProtocol.WriteJson(pipe,request,3000); var reply=SecureProtocol.ReadJson(pipe,15000);
                object ok; if(!reply.TryGetValue("ok",out ok) || !(ok is bool) || !(bool)ok) {object policy,input;string message=SecureProtocol.Text(reply,"error") ?? "Secure desktop request failed";if(reply.TryGetValue("policyRefusal",out policy)&&policy is bool&&(bool)policy&&reply.TryGetValue("inputSent",out input)&&input is bool&&!(bool)input)throw new SecurePolicyException(message);throw new IOException(message);}
                return reply;
            }
        }
    }
}
