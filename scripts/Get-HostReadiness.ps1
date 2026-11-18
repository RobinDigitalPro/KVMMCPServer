[CmdletBinding()]
param([switch]$AsJson)
$ErrorActionPreference = 'Stop'
if (-not ('OpenDesktopHid.Readiness' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace OpenDesktopHid {
    public static class Readiness {
        [DllImport("kernel32.dll")]
        public static extern uint WTSGetActiveConsoleSessionId();
        [StructLayout(LayoutKind.Sequential)]
        private struct Info { public uint Length, Options; }
        [DllImport("ntdll.dll")]
        private static extern int NtQuerySystemInformation(int informationClass, ref Info info, int length, out int returned);
        public static uint CodeIntegrityOptions() {
            Info info = new Info { Length = 8 }; int returned;
            int status = NtQuerySystemInformation(103, ref info, 8, out returned);
            if (status < 0) throw new InvalidOperationException("Code integrity query failed: " + status.ToString("X8"));
            return info.Options;
        }
    }
}
'@
}
$taskOptions = [OpenDesktopHid.Readiness]::CodeIntegrityOptions()
$taskPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$taskCurrentSession = (Get-Process -Id $PID).SessionId
$taskConsoleSession = [OpenDesktopHid.Readiness]::WTSGetActiveConsoleSessionId()
$taskSecureBoot = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State' -Name UEFISecureBootEnabled -ErrorAction SilentlyContinue
$taskResult = [pscustomobject]@{
    ReadOnly=$true
    AdministratorToken=$taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    SecureBootEnabled=$(if ($null -ne $taskSecureBoot) { $taskSecureBoot.UEFISecureBootEnabled -eq 1 } else { $null })
    TestSigningActive=(($taskOptions -band 2) -ne 0)
    HvciEnforced=(($taskOptions -band 0x400) -ne 0)
    CodeIntegrityOptions=('0x{0:X}' -f $taskOptions)
    CurrentSession=$taskCurrentSession
    ConsoleSession=$taskConsoleSession
    ConsoleSessionMatched=($taskConsoleSession -ne [uint32]::MaxValue -and $taskCurrentSession -eq $taskConsoleSession)
}
if ($AsJson) { $taskResult | ConvertTo-Json } else { $taskResult }
