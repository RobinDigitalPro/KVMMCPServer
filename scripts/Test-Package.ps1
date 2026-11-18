[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$EwdkRoot,
    [Parameter(Mandatory = $true)][string]$PackageDirectory,
    [Parameter(Mandatory = $true)][string]$ExpectedThumbprint,
    [Parameter(Mandatory = $true)][string]$ExpectedManifestSha256,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$taskSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
if (-not [IO.Path]::IsPathRooted($OutputDirectory) -or (Test-Path -LiteralPath $taskOutput) -or $taskOutput -eq $taskSource -or $taskOutput.StartsWith($taskSource + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Choose a new absolute external test-data directory' }
[IO.Directory]::CreateDirectory($taskOutput) | Out-Null
$taskInstaller = Join-Path $PSScriptRoot 'Install-Development.ps1'
$taskArgs = @{ EwdkRoot=$EwdkRoot; PackageDirectory=$PackageDirectory; ExpectedThumbprint=$ExpectedThumbprint; ExpectedManifestSha256=$ExpectedManifestSha256; ValidateOnly=$true }
$taskGood = & $taskInstaller @taskArgs
if (-not $taskGood.PackageVerified) { throw 'Valid package was not accepted' }
$taskWrongPinRejected = $false
# Pin tests call the actual read-only installer, not a copy of its validation.
$taskBadPinArgs = $taskArgs.Clone(); $taskBadPinArgs.ExpectedThumbprint = '0000000000000000000000000000000000000000'
try { & $taskInstaller @taskBadPinArgs | Out-Null } catch { if ($_.Exception.Message -like 'Pinned certificate thumbprint*') { $taskWrongPinRejected = $true } else { throw } }
if (-not $taskWrongPinRejected) { throw 'Wrong certificate pin was accepted' }
$taskFixture = Join-Path $taskOutput 'corrupt-copy'
[IO.Directory]::CreateDirectory($taskFixture) | Out-Null
foreach ($taskName in @('OpenDesktopHID.inf','OpenDesktopHID.sys','OpenDesktopHID.cat','OpenDesktopHID-Development.cer','signing.json')) { Copy-Item -LiteralPath (Join-Path $PackageDirectory $taskName) -Destination (Join-Path $taskFixture $taskName) }
$taskSys = Join-Path $taskFixture 'OpenDesktopHID.sys'
$taskBytes = [IO.File]::ReadAllBytes($taskSys); $taskBytes[$taskBytes.Length - 1] = $taskBytes[$taskBytes.Length - 1] -bxor 1; [IO.File]::WriteAllBytes($taskSys,$taskBytes)
$taskBadFileArgs = $taskArgs.Clone(); $taskBadFileArgs.PackageDirectory = $taskFixture
$taskCorruptionRejected = $false
try { & $taskInstaller @taskBadFileArgs | Out-Null } catch { if ($_.Exception.Message -eq 'Package hash mismatch: OpenDesktopHID.sys') { $taskCorruptionRejected = $true } else { throw } }
if (-not $taskCorruptionRejected) { throw 'Corrupted driver was accepted' }
# Even a changed manifest with matching attacker-supplied file hashes must fail
# the independently pinned manifest digest before any certificate is trusted.
$taskManifestPath = Join-Path $taskFixture 'signing.json'
$taskManifest = Get-Content -LiteralPath $taskManifestPath -Raw | ConvertFrom-Json
$taskManifest.files.'OpenDesktopHID.sys' = (Get-FileHash -LiteralPath $taskSys -Algorithm SHA256).Hash
$taskManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $taskManifestPath -Encoding utf8
$taskManifestRejected = $false
try { & $taskInstaller @taskBadFileArgs | Out-Null } catch { if ($_.Exception.Message -like 'Pinned manifest SHA256*') { $taskManifestRejected = $true } else { throw } }
if (-not $taskManifestRejected) { throw 'Changed driver plus changed manifest was accepted' }
$taskResult = [ordered]@{ checks=4; validPackageAccepted=$true; wrongCertificateRejected=$taskWrongPinRejected; corruptedDriverRejected=$taskCorruptionRejected; changedManifestRejected=$taskManifestRejected; driverInstalled=$false; trustModified=$false; inputSent=$false }
$taskResult | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskOutput 'results.json') -Encoding utf8
$taskResult | ConvertTo-Json
