#requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BuildDirectory,[Parameter(Mandatory=$true)][string]$OperatorSid)
$ErrorActionPreference='Stop'
$taskServiceName='KVMMCPServerSecureDesktop'
$taskTarget=Join-Path $env:ProgramFiles 'KVMMCPServer\SecureDesktop'
$taskOperator=New-Object System.Security.Principal.SecurityIdentifier($OperatorSid)
if(-not $taskOperator.IsAccountSid()){throw 'An operator account SID is required'}
$taskBuild=[IO.Path]::GetFullPath($BuildDirectory)
$taskManifest=Get-Content -LiteralPath (Join-Path $taskBuild 'secure-package.json') -Raw | ConvertFrom-Json
foreach($taskName in @('SecureDesktopBroker.exe','UacProbe.exe')){
    $taskHash=$taskManifest.hashes.$taskName
    if($taskHash -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath (Join-Path $taskBuild $taskName)).Hash -ne $taskHash){throw "Unexpected package hash: $taskName"}
}
if(Get-Service -Name $taskServiceName -ErrorAction SilentlyContinue){throw 'Existing service found; review an update instead of overwriting it'}
if(Test-Path -LiteralPath $taskTarget){throw 'Existing protected installation folder found'}
foreach($taskParent in @($env:ProgramFiles,(Join-Path $env:ProgramFiles 'KVMMCPServer'))){if((Test-Path -LiteralPath $taskParent) -and ((Get-Item -LiteralPath $taskParent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Reparse-point installation path rejected'}}
New-Item -ItemType Directory -Path $taskTarget -Force | Out-Null
$taskSystem=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$taskAdmins=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
$taskAcl=New-Object System.Security.AccessControl.DirectorySecurity
$taskAcl.SetOwner($taskAdmins);$taskAcl.SetAccessRuleProtection($true,$false)
foreach($taskSid in @($taskSystem,$taskAdmins)){$taskAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($taskSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
$taskAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($taskOperator,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl -LiteralPath $taskTarget -AclObject $taskAcl
foreach($taskName in @('SecureDesktopBroker.exe','UacProbe.exe')){Copy-Item -LiteralPath (Join-Path $taskBuild $taskName) -Destination (Join-Path $taskTarget $taskName)}
foreach($taskName in @('SecureDesktopBroker.exe','UacProbe.exe')){if((Get-FileHash -LiteralPath (Join-Path $taskTarget $taskName)).Hash -ne $taskManifest.hashes.$taskName){throw "Copied package hash mismatch: $taskName"}}
$taskConfig=@{operatorSid=$OperatorSid;applications=@(@{id='uac-probe';path=(Join-Path $taskTarget 'UacProbe.exe');sha256=$taskManifest.hashes.'UacProbe.exe'.ToLowerInvariant()})}
[IO.File]::WriteAllText((Join-Path $taskTarget 'secure-desktop.json'),($taskConfig|ConvertTo-Json -Depth 5),(New-Object Text.UTF8Encoding($false)))
foreach($taskFile in Get-ChildItem -LiteralPath $taskTarget -File){$taskFileAcl=Get-Acl -LiteralPath $taskFile.FullName;$taskFileAcl.SetOwner($taskAdmins);Set-Acl -LiteralPath $taskFile.FullName -AclObject $taskFileAcl}
New-Service -Name $taskServiceName -DisplayName 'KVMMCPServer Secure Desktop' -BinaryPathName ('"'+(Join-Path $taskTarget 'SecureDesktopBroker.exe')+'" --service') -StartupType Automatic -Description 'Local physical-console capture and one-shot HID consent responses for operator-approved executable hashes. No general SYSTEM shell.' | Out-Null
& "$env:SystemRoot\System32\sc.exe" privs $taskServiceName 'SeAssignPrimaryTokenPrivilege/SeIncreaseQuotaPrivilege/SeTcbPrivilege/SeChangeNotifyPrivilege/SeImpersonatePrivilege/SeCreateGlobalPrivilege'
if($LASTEXITCODE -ne 0){throw 'Cannot restrict service privileges'}
Start-Service -Name $taskServiceName
$taskReceipt=@{installedUtc=[DateTime]::UtcNow.ToString('o');service=$taskServiceName;status=(Get-Service $taskServiceName).Status.ToString();operatorSid=$OperatorSid;installedDirectory=$taskTarget;approvedApplications=$taskConfig.applications;hashes=$taskManifest.hashes;networkListener=$false;remotePipesRejected=$true;uacPoliciesChanged=$false;automaticReboot=$false}
[IO.File]::WriteAllText((Join-Path $taskTarget 'installation-receipt.json'),($taskReceipt|ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
Write-Output ('Installed and started '+$taskServiceName)
