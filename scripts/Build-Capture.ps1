[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$EwdkRoot, [Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$taskSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
if (-not [IO.Path]::IsPathRooted($OutputDirectory) -or $taskOutput -eq $taskSource -or $taskOutput.StartsWith($taskSource + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Use an absolute external build/data directory' }
$taskSetup = Join-Path $EwdkRoot 'BuildEnv\SetupBuildEnv.cmd'
if (-not (Test-Path -LiteralPath $taskSetup)) { throw 'EWDK setup not found' }
foreach ($taskPath in @($taskSource,$taskOutput,$taskSetup)) { if ($taskPath -match '[%\r\n&|<>^!]') { throw 'Unsupported build-path characters' } }
[IO.Directory]::CreateDirectory($taskOutput) | Out-Null
$taskBatch = Join-Path $taskOutput 'build-capture.cmd'
@'
@echo off
call "%KVM_CAPTURE_SETUP%" amd64
@echo off
if errorlevel 1 exit /b %errorlevel%
cd /d "%KVM_CAPTURE_OUTPUT%"
set "INCLUDE=%INCLUDE%;%WindowsSdkDir%Include\%Version_Number%\ucrt;%WindowsSdkDir%Include\%Version_Number%\shared;%WindowsSdkDir%Include\%Version_Number%\um;%WindowsSdkDir%Include\%Version_Number%\winrt"
set "LIB=%LIB%;%WindowsSdkDir%Lib\%Version_Number%\ucrt\x64;%WindowsSdkDir%Lib\%Version_Number%\um\x64"
cl.exe /nologo /std:c++17 /EHsc /W4 /WX /O2 /MT /DUNICODE /D_UNICODE "%KVM_CAPTURE_SOURCE%" /Fo"ScreenCapture.obj" /Fe"ScreenCapture.exe" /link d3d11.lib dxgi.lib windowscodecs.lib mfplat.lib mfreadwrite.lib mfuuid.lib ole32.lib oleaut32.lib user32.lib gdi32.lib wtsapi32.lib winmm.lib
exit /b %errorlevel%
'@ | Set-Content -LiteralPath $taskBatch -Encoding ascii
$taskVariables = @{ KVM_CAPTURE_SETUP=$taskSetup; KVM_CAPTURE_OUTPUT=$taskOutput; KVM_CAPTURE_SOURCE=(Join-Path $taskSource 'native\ScreenCapture.cpp') }
$taskPrevious = @{}
foreach ($taskName in $taskVariables.Keys) { $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process'); [Environment]::SetEnvironmentVariable($taskName, $taskVariables[$taskName], 'Process') }
try {
    & $env:ComSpec /d /c $taskBatch 2>&1 | Tee-Object -FilePath (Join-Path $taskOutput 'build-capture.txt')
    if ($LASTEXITCODE -ne 0) { throw "Capture build failed: $LASTEXITCODE" }
    Get-Item -LiteralPath (Join-Path $taskOutput 'ScreenCapture.exe') | Select-Object FullName,Length
} finally { foreach ($taskName in $taskVariables.Keys) { [Environment]::SetEnvironmentVariable($taskName, $taskPrevious[$taskName], 'Process') } }
