[CmdletBinding()]
param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
# Local paths and independently pinned hashes are deployment configuration,
# excluded from the public source repository.
$taskSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskConfig = Get-Content -LiteralPath (Join-Path $taskSource 'deployment.local.json') -Raw | ConvertFrom-Json
$taskIso = Join-Path $taskSource 'toolchain\EWDK-26100.iso'
$taskImage = Get-DiskImage -ImagePath $taskIso
if (-not $taskImage.Attached) { $taskImage = Mount-DiskImage -ImagePath $taskIso -Access ReadOnly -PassThru }
$taskVolume = $taskImage | Get-Volume
$taskEwdk = $taskVolume.DriveLetter + ':\'
& (Join-Path $PSScriptRoot 'Install-Development.ps1') -EwdkRoot $taskEwdk -PackageDirectory $taskConfig.signedPackage -ExpectedThumbprint $taskConfig.certificateThumbprint -ExpectedManifestSha256 $taskConfig.manifestSha256 -ValidateOnly:$ValidateOnly
