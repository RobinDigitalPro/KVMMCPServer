[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$EwdkRoot,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [ValidateSet('Debug','Release')][string]$Configuration = 'Debug'
)
$ErrorActionPreference = 'Stop'
$taskSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
if (-not [IO.Path]::IsPathRooted($OutputDirectory) -or $taskOutput -eq $taskSource -or $taskOutput.StartsWith($taskSource + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputDirectory must be an absolute external build/data directory' }
$taskEwdk = [IO.Path]::GetFullPath($EwdkRoot)
$taskSetup = Join-Path $taskEwdk 'BuildEnv\SetupBuildEnv.cmd'
if (-not (Test-Path -LiteralPath $taskSetup)) { throw "EWDK setup not found: $taskSetup" }
$taskBuild = Join-Path $taskOutput $Configuration
$taskObj = Join-Path $taskBuild 'obj'
$taskPackage = Join-Path $taskBuild 'package'
foreach ($taskDir in @($taskBuild,$taskObj,$taskPackage)) { [IO.Directory]::CreateDirectory($taskDir) | Out-Null }
# Use environment variables instead of interpolating paths into executable batch
# text. cmd.exe metacharacters in caller-controlled paths are rejected as well.
foreach ($taskPath in @($taskSource,$taskOutput,$taskEwdk)) { if ($taskPath -match '[%\r\n&|<>^!]') { throw 'Unsupported metacharacter in build path' } }
$taskBatch = Join-Path $taskBuild 'build-driver.cmd'
$taskRsp = Join-Path $taskBuild 'driver.rsp'
@(
    ('"' + (Join-Path $taskSource 'driver\OpenDesktopHID.vcxproj') + '"'),
    '/nologo', '/m:1', '/t:Build',
    "/p:Configuration=$Configuration", '/p:Platform=x64', '/p:OdhExternalBuild=true',
    ('/p:OutDir="' + $taskPackage + [char]92 + [char]92 + '"'),
    ('/p:IntDir="' + $taskObj + [char]92 + [char]92 + '"'),
    ('/bl:"' + (Join-Path $taskBuild 'driver.binlog') + '"'),
    '/verbosity:minimal'
) | Set-Content -LiteralPath $taskRsp -Encoding ascii
@'
@echo off
call "%ODH_EWDK_SETUP%" amd64
@echo off
if errorlevel 1 exit /b %errorlevel%
cd /d "%ODH_BUILD_DATA%"
setlocal
set "INCLUDE=%INCLUDE%;%WindowsSdkDir%Include\%Version_Number%\ucrt;%WindowsSdkDir%Include\%Version_Number%\shared;%WindowsSdkDir%Include\%Version_Number%\um"
set "LIB=%LIB%;%WindowsSdkDir%Lib\%Version_Number%\ucrt\x64;%WindowsSdkDir%Lib\%Version_Number%\um\x64"
cl.exe /nologo /W4 /WX /O2 /MT /TC "%ODH_CONTRACT_SOURCE%" /Fo"%ODH_BUILD_DATA%\contract.obj" /Fe"%ODH_BUILD_DATA%\contract.exe"
if errorlevel 1 exit /b %errorlevel%
"%ODH_BUILD_DATA%\contract.exe"
if errorlevel 1 exit /b %errorlevel%
endlocal
msbuild.exe @"%ODH_DRIVER_RSP%"
exit /b %errorlevel%
'@ | Set-Content -LiteralPath $taskBatch -Encoding ascii
$taskNames = @('ODH_EWDK_SETUP','ODH_BUILD_DATA','ODH_CONTRACT_SOURCE','ODH_DRIVER_RSP')
$taskPrevious = @{}
foreach ($taskName in $taskNames) { $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process') }
try {
    $env:ODH_EWDK_SETUP = $taskSetup
    $env:ODH_BUILD_DATA = $taskBuild
    $env:ODH_CONTRACT_SOURCE = Join-Path $taskSource 'test\contract.c'
    $env:ODH_DRIVER_RSP = $taskRsp
    $taskTimer = [Diagnostics.Stopwatch]::StartNew()
    & $env:ComSpec /d /c $taskBatch 2>&1 | Tee-Object -FilePath (Join-Path $taskBuild 'build.txt')
    $taskExit = $LASTEXITCODE
    $taskTimer.Stop()
    @{ exitCode=$taskExit; durationMs=$taskTimer.ElapsedMilliseconds; configuration=$Configuration; driverInstalled=$false; inputSent=$false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskBuild 'summary.json') -Encoding utf8
    if ($taskExit -ne 0) { throw "Driver/C contract build failed: $taskExit" }
    Get-ChildItem -LiteralPath $taskPackage -Recurse -File | Select-Object FullName,Length
} finally {
    foreach ($taskName in $taskNames) { [Environment]::SetEnvironmentVariable($taskName, $taskPrevious[$taskName], 'Process') }
}
