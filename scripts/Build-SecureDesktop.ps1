[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$taskSource=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskOutput=[IO.Path]::GetFullPath($OutputDirectory)
if (-not [IO.Path]::IsPathRooted($OutputDirectory) -or $taskOutput -eq $taskSource -or $taskOutput.StartsWith($taskSource+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Use an absolute external build directory' }
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskFramework=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$taskCompiler=Join-Path $taskFramework 'csc.exe'
$taskRefs=@('/r:System.Web.Extensions.dll','/r:System.Drawing.dll','/r:System.ServiceProcess.dll',('/r:'+ (Join-Path $taskFramework 'WPF\UIAutomationClient.dll')),('/r:'+(Join-Path $taskFramework 'WPF\UIAutomationTypes.dll')),('/r:'+(Join-Path $taskFramework 'WPF\WindowsBase.dll')))
& $taskCompiler /nologo /target:exe /platform:x64 /optimize+ /warnaserror+ /main:OpenDesktopHid.SecureDesktopProgram $taskRefs ('/out:'+(Join-Path $taskOutput 'SecureDesktopBroker.exe')) (Join-Path $taskSource 'native\SecureDesktopBroker.cs') (Join-Path $taskSource 'native\SecureDesktopClient.cs') (Join-Path $taskSource 'native\HidTransport.cs') (Join-Path $taskSource 'native\KeyboardText.cs')
if($LASTEXITCODE -ne 0){throw 'Secure desktop build failed'}
& (Join-Path $taskOutput 'SecureDesktopBroker.exe') self-test
if($LASTEXITCODE -ne 0){throw 'Secure desktop protocol self-test failed'}
& $taskCompiler /nologo /target:winexe /platform:x64 /optimize+ /warnaserror+ ('/win32manifest:'+(Join-Path $taskSource 'native\UacProbe.manifest')) ('/out:'+(Join-Path $taskOutput 'UacProbe.exe')) (Join-Path $taskSource 'native\UacProbe.cs')
if($LASTEXITCODE -ne 0){throw 'UAC probe build failed'}
Get-FileHash -LiteralPath (Join-Path $taskOutput 'SecureDesktopBroker.exe'),(Join-Path $taskOutput 'UacProbe.exe') -Algorithm SHA256
