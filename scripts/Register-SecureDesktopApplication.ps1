#requires -RunAsAdministrator
# Legacy 0.5.x staging/metadata utility. Policy 0.8.0 has no application
# allowlist; running this script is not required to permit UAC consent.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9][a-z0-9-]{0,39}$')][string]$Id,[Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$Sha256)
$ErrorActionPreference='Stop'
$taskRoot=Join-Path $env:ProgramFiles 'KVMMCPServer\SecureDesktop'
$taskConfigPath=Join-Path $taskRoot 'secure-desktop.json'
if(-not(Test-Path -LiteralPath $taskConfigPath)){throw 'Install the secure-desktop service first'}
if(Get-Process -Name HidTransport -ErrorAction SilentlyContinue){throw 'Stop the desktop controller before changing its privileged application permissions'}
$taskSource=[IO.Path]::GetFullPath($Executable)
if(-not[IO.Path]::IsPathRooted($Executable) -or [IO.Path]::GetExtension($taskSource) -ne '.exe' -or ((Get-Item -LiteralPath $taskSource -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Use a regular local executable'}
if([IO.Path]::GetFileName($taskSource).ToLowerInvariant() -in @('powershell.exe','pwsh.exe','cmd.exe','wscript.exe','cscript.exe','mshta.exe','rundll32.exe','regsvr32.exe','node.exe','python.exe','dotnet.exe','msiexec.exe')){throw 'General command interpreters are not suitable UAC application grants'}
if((Get-FileHash -LiteralPath $taskSource).Hash -ne $Sha256){throw 'Source does not match the operator-approved SHA-256'}
$taskConfig=Get-Content -LiteralPath $taskConfigPath -Raw|ConvertFrom-Json
if(@($taskConfig.applications|Where-Object id -eq $Id).Count){throw 'Application ID already exists; review an explicit permission update instead'}
if(@($taskConfig.applications).Count -ge 32){throw 'Application permission limit reached'}
$taskDirectory=Join-Path $taskRoot ('Applications\'+$Id)
if(Test-Path -LiteralPath $taskDirectory){throw 'Existing application staging directory found'}
foreach($taskPath in @($taskRoot,(Join-Path $taskRoot 'Applications'))){if((Test-Path -LiteralPath $taskPath) -and ((Get-Item -LiteralPath $taskPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Reparse-point installation directory rejected'}}
Stop-Service -Name KVMMCPServerSecureDesktop
try {
    New-Item -ItemType Directory -Path $taskDirectory -Force|Out-Null
    $taskTarget=Join-Path $taskDirectory ([IO.Path]::GetFileName($taskSource))
    Copy-Item -LiteralPath $taskSource -Destination $taskTarget
    if((Get-FileHash -LiteralPath $taskTarget).Hash -ne $Sha256){throw 'Copied application hash mismatch'}
    $taskOwner=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    foreach($taskPath in @($taskDirectory,$taskTarget)){$taskAcl=Get-Acl -LiteralPath $taskPath;$taskAcl.SetOwner($taskOwner);Set-Acl -LiteralPath $taskPath -AclObject $taskAcl}
    $taskConfig.applications=@($taskConfig.applications)+@(@{id=$Id;path=$taskTarget;sha256=$Sha256.ToLowerInvariant()})
    [IO.File]::WriteAllText($taskConfigPath,($taskConfig|ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
} finally {Start-Service -Name KVMMCPServerSecureDesktop}
Write-Output ('Registered '+$Id+'. Launch the protected staged executable; refresh the controller before agent use.')
