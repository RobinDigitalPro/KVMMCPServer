[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $taskCompiler)) { throw '.NET Framework 4.x x64 compiler is required' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'OutputDirectory must be an absolute data/build directory' }
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
$taskSourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($taskOutput.StartsWith($taskSourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $taskOutput -eq $taskSourceRoot) { throw 'Keep build data outside the source/setup directory' }
[IO.Directory]::CreateDirectory($taskOutput) | Out-Null
$taskExe = Join-Path $taskOutput 'HidTransport.exe'
& $taskCompiler /nologo /target:exe /platform:x64 /optimize+ /warnaserror+ /r:System.Web.Extensions.dll /r:System.Drawing.dll "/out:$taskExe" (Join-Path $taskSourceRoot 'native\HidTransport.cs')
if ($LASTEXITCODE -ne 0) { throw "Native build failed: $LASTEXITCODE" }
& $taskExe self-test
if ($LASTEXITCODE -ne 0) { throw 'Native wire tests failed' }
Write-Output "Built $taskExe"
