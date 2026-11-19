#requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$BuildDirectory,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedInstalledSha256,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$PackageManifestSha256,
    [switch]$ConfirmControllerStopped
)
$ErrorActionPreference='Stop'
$taskName='KVMMCPServerSecureDesktop'
$taskTarget=Join-Path $env:ProgramFiles 'KVMMCPServer\SecureDesktop'
$taskExe=Join-Path $taskTarget 'SecureDesktopBroker.exe'
if(-not $ConfirmControllerStopped -or (Get-Process -Name HidTransport -ErrorAction SilentlyContinue)){throw 'Stop all HID controllers before updating the service'}
$taskBuild=[IO.Path]::GetFullPath($BuildDirectory)
$taskManifestPath=Join-Path $taskBuild 'secure-package.json'
if((Get-FileHash -LiteralPath $taskManifestPath).Hash -ne $PackageManifestSha256){throw 'Package manifest changed'}
$taskManifest=Get-Content -LiteralPath $taskManifestPath -Raw|ConvertFrom-Json
$taskHash=$taskManifest.hashes.'SecureDesktopBroker.exe'
if($taskHash -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath (Join-Path $taskBuild 'SecureDesktopBroker.exe')).Hash -ne $taskHash){throw 'Candidate executable hash mismatch'}
foreach($taskPath in @($taskTarget,$taskExe,(Join-Path $taskTarget 'secure-desktop.json'))){
    if((Get-Item -LiteralPath $taskPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse-point protected target rejected'}
    $taskOwner=(Get-Acl -LiteralPath $taskPath).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if($taskOwner -notin 'S-1-5-18','S-1-5-32-544'){throw 'Protected installation ownership is unexpected'}
}
if((Get-FileHash -LiteralPath $taskExe).Hash -ne $ExpectedInstalledSha256){throw 'Installed executable changed; review the update again'}
$taskService=Get-CimInstance Win32_Service -Filter "Name='KVMMCPServerSecureDesktop'"
if(-not $taskService -or $taskService.StartName -ne 'LocalSystem' -or $taskService.PathName -ne ('"'+$taskExe+'" --service')){throw 'Unexpected service registration'}
$taskBackup=Join-Path $taskTarget ('Updates\'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssffffZ'))
New-Item -ItemType Directory -Path $taskBackup -ErrorAction Stop|Out-Null
Copy-Item -LiteralPath $taskExe -Destination (Join-Path $taskBackup 'SecureDesktopBroker.exe')
Copy-Item -LiteralPath (Join-Path $taskTarget 'installation-receipt.json') -Destination (Join-Path $taskBackup 'installation-receipt.json')
Stop-Service -Name $taskName
try {
    Copy-Item -LiteralPath (Join-Path $taskBuild 'SecureDesktopBroker.exe') -Destination $taskExe -Force
    $taskAcl=Get-Acl -LiteralPath $taskExe;$taskAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')));Set-Acl -LiteralPath $taskExe -AclObject $taskAcl
    if((Get-FileHash -LiteralPath $taskExe).Hash -ne $taskHash){throw 'Copied executable hash mismatch'}
    Start-Service -Name $taskName
    Start-Sleep -Milliseconds 500
    if((Get-Service -Name $taskName).Status -ne 'Running'){throw 'Updated service failed to start'}
    $taskReceipt=Get-Content -LiteralPath (Join-Path $taskTarget 'installation-receipt.json') -Raw|ConvertFrom-Json
    $taskReceipt.hashes.'SecureDesktopBroker.exe'=$taskHash
    $taskReceipt|Add-Member -NotePropertyName updatedUtc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    $taskReceipt|Add-Member -NotePropertyName sourceCommit -NotePropertyValue $taskManifest.sourceCommit -Force
    $taskReceipt|Add-Member -NotePropertyName updateBackup -NotePropertyValue $taskBackup -Force
    [IO.File]::WriteAllText((Join-Path $taskTarget 'installation-receipt.json'),($taskReceipt|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
} catch {
    $taskFailure=$_.Exception.Message
    Stop-Service -Name $taskName -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath (Join-Path $taskBackup 'SecureDesktopBroker.exe') -Destination $taskExe -Force
    Copy-Item -LiteralPath (Join-Path $taskBackup 'installation-receipt.json') -Destination (Join-Path $taskTarget 'installation-receipt.json') -Force
    Start-Service -Name $taskName
    throw ('Update failed; previous executable restored: '+$taskFailure)
}
Write-Output 'Secure Desktop service updated. Approved applications and UAC policy were preserved. Restart the ordinary controller and verify live acceptance.'
