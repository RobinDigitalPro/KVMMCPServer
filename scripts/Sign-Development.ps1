[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$EwdkRoot,
    [Parameter(Mandatory = $true)][string]$PackageDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$taskSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
$taskInput = [IO.Path]::GetFullPath($PackageDirectory)
if (-not [IO.Path]::IsPathRooted($OutputDirectory) -or $taskOutput -eq $taskInput -or $taskOutput -eq $taskSource -or $taskOutput.StartsWith($taskSource + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Choose a new absolute external signing output directory' }
if (Test-Path -LiteralPath $taskOutput) { throw 'Signing output directory must not already exist' }
foreach ($taskName in @('OpenDesktopHID.inf','OpenDesktopHID.sys')) { if (-not (Test-Path -LiteralPath (Join-Path $taskInput $taskName))) { throw "Missing package input: $taskName" } }
$taskSignTool = Join-Path $EwdkRoot 'Program Files\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe'
$taskInf2Cat = Join-Path $EwdkRoot 'Program Files\Windows Kits\10\bin\10.0.26100.0\x86\Inf2Cat.exe'
if ((Get-AuthenticodeSignature -LiteralPath $taskSignTool).Status -ne 'Valid') { throw 'Microsoft signtool signature validation failed' }
# This particular official EWDK ships Inf2Cat with a Microsoft internal build
# certificate whose chain is not trusted on this host. Pin the exact executable
# from the HTTPS-downloaded, read-only 26100.6584 image instead of trusting its
# internal root certificate in Windows. Other unsigned/changed files are refused.
$taskInfSignature = Get-AuthenticodeSignature -LiteralPath $taskInf2Cat
$taskInfHash = (Get-FileHash -LiteralPath $taskInf2Cat -Algorithm SHA256).Hash
if ($taskInfSignature.Status -ne 'Valid' -and $taskInfHash -ne 'B594728D38B271979367ABC8060A971B8E42422738009BE126710B1F5DD0FCBC') { throw 'Inf2Cat is not the pinned official EWDK executable' }
$taskSubject = 'CN=OpenDesktopHID Local Development'
$taskCert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $taskSubject -and $_.Issuer -eq $taskSubject -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(7) } | Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $taskCert) {
    # A non-exportable current-user key. No machine trust store is modified.
    $taskCert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $taskSubject -FriendlyName 'OpenDesktopHID local driver development' -CertStoreLocation Cert:\CurrentUser\My -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(1)
}
[IO.Directory]::CreateDirectory($taskOutput) | Out-Null
foreach ($taskName in @('OpenDesktopHID.inf','OpenDesktopHID.sys')) { Copy-Item -LiteralPath (Join-Path $taskInput $taskName) -Destination (Join-Path $taskOutput $taskName) }
$taskSys = Join-Path $taskOutput 'OpenDesktopHID.sys'
& $taskSignTool sign /fd SHA256 /sha1 $taskCert.Thumbprint /s My $taskSys
if ($LASTEXITCODE -ne 0) { throw 'SYS signing failed' }
# Rebuild the catalog after signing the SYS: its file hash has changed.
& $taskInf2Cat "/driver:$taskOutput" /os:10_GE_X64 /uselocaltime
if ($LASTEXITCODE -ne 0) { throw 'Signed package catalog generation failed' }
$taskCat = Join-Path $taskOutput 'OpenDesktopHID.cat'
& $taskSignTool sign /fd SHA256 /sha1 $taskCert.Thumbprint /s My $taskCat
if ($LASTEXITCODE -ne 0) { throw 'CAT signing failed' }
Export-Certificate -Cert $taskCert -FilePath (Join-Path $taskOutput 'OpenDesktopHID-Development.cer') -Type CERT | Out-Null

# Independently verify the catalog's cryptographic signature, without trusting
# the self-signed certificate in a user/machine root store.
Add-Type -AssemblyName System.Security.Cryptography.Pkcs
$taskCms = [Security.Cryptography.Pkcs.SignedCms]::new()
$taskCms.Decode([IO.File]::ReadAllBytes($taskCat))
$taskCms.CheckSignature($true)
$taskSysSignature = Get-AuthenticodeSignature -LiteralPath $taskSys
if ($taskSysSignature.SignerCertificate.Thumbprint -ne $taskCert.Thumbprint -or $taskSysSignature.Status -in @('NotSigned','HashMismatch')) { throw 'Unexpected SYS signature' }
$taskFiles = @{}
foreach ($taskName in @('OpenDesktopHID.inf','OpenDesktopHID.sys','OpenDesktopHID.cat','OpenDesktopHID-Development.cer')) { $taskFiles[$taskName] = (Get-FileHash -LiteralPath (Join-Path $taskOutput $taskName) -Algorithm SHA256).Hash }
[ordered]@{
    certificateThumbprint=$taskCert.Thumbprint
    certificateSubject=$taskCert.Subject
    certificateExpires=$taskCert.NotAfter.ToUniversalTime().ToString('o')
    sysSignatureStatus=$taskSysSignature.Status.ToString()
    catalogCryptographicSignatureVerified=$true
    machineTrustModified=$false
    bootSettingsModified=$false
    driverInstalled=$false
    inputSent=$false
    files=$taskFiles
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $taskOutput 'signing.json') -Encoding utf8
Write-Output "Development-signed package: $taskOutput"
Write-Output ('Certificate thumbprint: ' + $taskCert.Thumbprint)
Write-Output ('Manifest SHA256: ' + (Get-FileHash -LiteralPath (Join-Path $taskOutput 'signing.json') -Algorithm SHA256).Hash)
Write-Output 'No root trust, boot changes or installation performed.'
