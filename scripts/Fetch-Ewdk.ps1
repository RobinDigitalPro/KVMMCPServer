[CmdletBinding()]
param([string]$Destination = (Join-Path $PSScriptRoot '..\toolchain\EWDK-26100.iso'))
$ErrorActionPreference = 'Stop'
# Official Microsoft standalone compiler + SDK + WDK. This only downloads;
# it does not mount the image, install a driver, or change boot settings.
$taskUrl = 'https://download.microsoft.com/download/be985897-caaa-4497-9ea4-17fa7065cd8a/EWDK_ge_release_svc_prod1_26100_250904-1728.iso'
$taskDestination = [IO.Path]::GetFullPath($Destination)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($taskDestination)) | Out-Null
if (Test-Path -LiteralPath $taskDestination) { throw 'Destination already exists; verify it rather than replacing it' }
$taskPartial = $taskDestination + '.partial'
if (Test-Path -LiteralPath $taskPartial) { throw 'A partial download exists; inspect it before retrying' }
Invoke-WebRequest -Uri $taskUrl -OutFile $taskPartial -TimeoutSec 3600
Move-Item -LiteralPath $taskPartial -Destination $taskDestination
Get-Item -LiteralPath $taskDestination | Select-Object FullName,Length
