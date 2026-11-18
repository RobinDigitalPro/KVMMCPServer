[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$taskSourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
if (-not [IO.Path]::IsPathRooted($OutputDirectory) -or $taskOutput -eq $taskSourceRoot -or $taskOutput.StartsWith($taskSourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Use an absolute external data/build directory' }
[IO.Directory]::CreateDirectory($taskOutput) | Out-Null
$taskExe = Join-Path $taskOutput 'InputObserver.exe'
& $taskCompiler /nologo /target:winexe /platform:x64 /optimize+ /warnaserror+ /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll "/out:$taskExe" (Join-Path $taskSourceRoot 'native\InputObserver.cs')
if ($LASTEXITCODE -ne 0) { throw "Observer build failed: $LASTEXITCODE" }
Write-Output "Built receiver-only test window: $taskExe"
