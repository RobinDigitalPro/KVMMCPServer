// MIT. Harmless elevation probe: returns success only with an elevated token.
using System;
using System.Reflection;
using System.Security.Principal;
[assembly: AssemblyTitle("KVMMCPServer UAC Probe")]
[assembly: AssemblyProduct("KVMMCPServer UAC Probe")]
internal static class UacProbe {
    [STAThread] private static int Main() {
        return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator) ? 0 : 1;
    }
}
