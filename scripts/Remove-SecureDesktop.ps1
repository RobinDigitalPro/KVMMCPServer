#requires -RunAsAdministrator
[CmdletBinding()]
param([switch]$ConfirmControllerStopped)
$ErrorActionPreference='Stop'
if(-not $ConfirmControllerStopped -or (Get-Process -Name HidTransport -ErrorAction SilentlyContinue)){throw 'Stop the controller and confirm it before removing the service'}
$taskName='KVMMCPServerSecureDesktop'
$taskService=Get-Service -Name $taskName -ErrorAction SilentlyContinue
if($taskService){Stop-Service -Name $taskName; & "$env:SystemRoot\System32\sc.exe" delete $taskName;if($LASTEXITCODE -ne 0){throw 'Service removal failed'}}
Write-Output 'Service removed. Protected installation files are retained for review; no recordings or third-party drivers were deleted.'
