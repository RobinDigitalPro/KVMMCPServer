[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
if(-not[IO.Path]::IsPathRooted($OutputDirectory)){throw 'Use an absolute external test directory'}
$taskRoot=[IO.Path]::GetFullPath($OutputDirectory)
$taskSource=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if($taskRoot -eq $taskSource -or $taskRoot.StartsWith($taskSource+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Keep test artifacts outside source'}
$taskExe=Join-Path $env:ProgramFiles 'KVMMCPServer\SecureDesktop\SecureDesktopBroker.exe'
if((Get-Service KVMMCPServerSecureDesktop).Status -ne 'Running'){throw 'Install/start the optional secure-desktop service first'}
$taskStatus=& $taskExe status|ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or -not $taskStatus.system){throw 'SYSTEM console helper status failed'}
New-Item -ItemType Directory -Path $taskRoot -Force|Out-Null
$taskInfo=New-Object Diagnostics.ProcessStartInfo
$taskInfo.FileName=$taskExe;$taskInfo.Arguments='frame';$taskInfo.UseShellExecute=$false;$taskInfo.CreateNoWindow=$true;$taskInfo.RedirectStandardOutput=$true;$taskInfo.RedirectStandardError=$true
$taskProcess=New-Object Diagnostics.Process;$taskProcess.StartInfo=$taskInfo
if(-not$taskProcess.Start()){throw 'Cannot start read-only frame client'}
try {
    $taskReader=New-Object IO.BinaryReader($taskProcess.StandardOutput.BaseStream)
    $taskHeader=$taskReader.ReadBytes(64)
    if($taskHeader.Length -ne 64 -or [BitConverter]::ToInt32($taskHeader,0) -ne 0x31464355 -or [BitConverter]::ToInt32($taskHeader,8) -ne 0){throw 'Secure frame header invalid'}
    $taskWidth=[BitConverter]::ToInt32($taskHeader,16);$taskHeight=[BitConverter]::ToInt32($taskHeader,20);$taskCount=[BitConverter]::ToInt32($taskHeader,32)
    if($taskWidth -lt 1 -or $taskHeight -lt 1 -or [long]$taskWidth*$taskHeight*4 -ne $taskCount -or $taskCount -gt 64MB){throw 'Secure frame size invalid'}
    $taskPixels=$taskReader.ReadBytes($taskCount);if($taskPixels.Length -ne $taskCount){throw 'Truncated frame'}
    Add-Type -AssemblyName System.Drawing
    $taskBitmap=New-Object Drawing.Bitmap($taskWidth,$taskHeight,[Drawing.Imaging.PixelFormat]::Format32bppRgb)
    try{$taskRect=New-Object Drawing.Rectangle(0,0,$taskWidth,$taskHeight);$taskData=$taskBitmap.LockBits($taskRect,[Drawing.Imaging.ImageLockMode]::WriteOnly,[Drawing.Imaging.PixelFormat]::Format32bppRgb);try{for($taskRow=0;$taskRow -lt $taskHeight;$taskRow++){[Runtime.InteropServices.Marshal]::Copy($taskPixels,$taskRow*$taskWidth*4,[IntPtr]::Add($taskData.Scan0,$taskRow*$taskData.Stride),$taskWidth*4)}}finally{$taskBitmap.UnlockBits($taskData)};$taskBitmap.Save((Join-Path $taskRoot 'system-console.png'),[Drawing.Imaging.ImageFormat]::Png)}finally{$taskBitmap.Dispose()}
    if(-not$taskProcess.WaitForExit(3000) -or $taskProcess.ExitCode -ne 0){throw 'Frame client did not exit successfully'}
    $taskReceipt=@{verifiedUtc=[DateTime]::UtcNow.ToString('o');systemHelper=$taskStatus;session=[BitConverter]::ToUInt32($taskHeader,12);width=$taskWidth;height=$taskHeight;desktopCode=([BitConverter]::ToInt32($taskHeader,36) -band 255);cursorIncluded=([BitConverter]::ToInt32($taskHeader,36) -band 256) -ne 0;image=(Join-Path $taskRoot 'system-console.png');inputSent=$false;visualInspectionRequired=$true}
    [IO.File]::WriteAllText((Join-Path $taskRoot 'service-verification.json'),($taskReceipt|ConvertTo-Json -Depth 7),(New-Object Text.UTF8Encoding($false)))
    $taskReceipt|ConvertTo-Json -Depth 5
} finally {if(-not$taskProcess.HasExited){$taskProcess.Kill()};$taskProcess.Dispose()}
