[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$EwdkRoot,
    [Parameter(Mandatory = $true)][string]$PackageDirectory,
    [Parameter(Mandatory = $true)][string]$ExpectedThumbprint,
    [Parameter(Mandatory = $true)][string]$ExpectedManifestSha256,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
$taskPackage = [IO.Path]::GetFullPath($PackageDirectory)
$taskManifestPath = Join-Path $taskPackage 'signing.json'
if ($ExpectedManifestSha256 -notmatch '^[0-9A-Fa-f]{64}$' -or (Get-FileHash -LiteralPath $taskManifestPath -Algorithm SHA256).Hash -ne $ExpectedManifestSha256) { throw 'Pinned manifest SHA256 does not match the package' }
$taskManifest = Get-Content -LiteralPath $taskManifestPath -Raw | ConvertFrom-Json
$taskThumbprint = $ExpectedThumbprint.Replace(' ','').ToUpperInvariant()
if ($taskThumbprint -notmatch '^[0-9A-F]{40}$' -or $taskManifest.certificateThumbprint -ne $taskThumbprint) { throw 'Pinned certificate thumbprint does not match the package' }
$taskNames = @('OpenDesktopHID.inf','OpenDesktopHID.sys','OpenDesktopHID.cat','OpenDesktopHID-Development.cer')
foreach ($taskName in $taskNames) {
    $taskHash = (Get-FileHash -LiteralPath (Join-Path $taskPackage $taskName) -Algorithm SHA256).Hash
    if ($taskHash -ne $taskManifest.files.$taskName) { throw "Package hash mismatch: $taskName" }
}
$taskCertificatePath = Join-Path $taskPackage 'OpenDesktopHID-Development.cer'
$taskCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($taskCertificatePath)
if ($taskCertificate.Thumbprint -ne $taskThumbprint -or $taskCertificate.Subject -ne 'CN=OpenDesktopHID Local Development' -or $taskCertificate.NotBefore -gt (Get-Date) -or $taskCertificate.NotAfter -le (Get-Date)) { throw 'Unexpected or expired package certificate' }
$taskSignature = Get-AuthenticodeSignature -LiteralPath (Join-Path $taskPackage 'OpenDesktopHID.sys')
if ($taskSignature.SignerCertificate.Thumbprint -ne $taskThumbprint -or $taskSignature.Status -in @('NotSigned','HashMismatch')) { throw 'Unexpected driver signature' }
$taskDevcon = Join-Path $EwdkRoot 'Program Files\Windows Kits\10\Tools\10.0.26100.0\x64\devcon.exe'
if ((Get-AuthenticodeSignature -LiteralPath $taskDevcon).Status -ne 'Valid') { throw 'Microsoft DevCon signature validation failed' }
$taskHost = & (Join-Path $PSScriptRoot 'Get-HostReadiness.ps1')
if ($ValidateOnly) {
    [pscustomobject]@{ PackageVerified=$true; CertificateThumbprint=$taskThumbprint; Host=$taskHost; DriverInstalled=$false }
    return
}
if (-not $taskHost.AdministratorToken) { throw 'Run this narrowly scoped installer in an administrator PowerShell window' }
if ($taskHost.SecureBootEnabled -ne $false -or -not $taskHost.TestSigningActive) { throw 'Secure Boot must be off and Test Mode must already be active after reboot; no trust or installation changes made' }
if (Test-Path -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\OpenDesktopHID') { throw 'An OpenDesktopHID service already exists; inspect/update it rather than creating a duplicate root device' }

# This is the explicit host mutation stage. It neither changes boot settings nor
# starts any agent/server. Trust is limited to the independently pinned cert.
Import-Certificate -FilePath $taskCertificatePath -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Import-Certificate -FilePath $taskCertificatePath -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
& $taskDevcon install (Join-Path $taskPackage 'OpenDesktopHID.inf') 'ROOT\OpenDesktopHID'
$taskExit = $LASTEXITCODE
if ($taskExit -notin @(0,1)) { throw "Device installation failed: $taskExit" }
[pscustomobject]@{ DriverInstalled=$true; RebootRequired=($taskExit -eq 1); CertificateThumbprint=$taskThumbprint; InputTested=$false }
