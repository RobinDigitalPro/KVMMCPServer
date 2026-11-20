[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Configuration,
    [Parameter(Mandatory=$true)][string]$CaptureExecutable,
    [string]$HidExecutable,
    [switch]$ConfirmIdle,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
if (-not $ConfirmIdle) { throw 'Finish other agent work, close its MCP connection, then supply -ConfirmIdle. No update was applied.' }
$taskConfig = Get-Content -LiteralPath $Configuration -Raw | ConvertFrom-Json
$taskSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskTarget = [IO.Path]::GetFullPath($taskConfig.sourceRoot)
$taskData = [IO.Path]::GetFullPath($taskConfig.dataRoot)
$taskCapture = [IO.Path]::GetFullPath($CaptureExecutable)
foreach ($taskValue in @($taskConfig.sourceRoot,$taskConfig.dataRoot,$taskConfig.nativeExecutable,$taskConfig.nodeExecutable,$CaptureExecutable)) { if (-not [IO.Path]::IsPathRooted($taskValue)) { throw 'Deployment paths must be absolute' } }
if (-not (Test-Path -LiteralPath (Join-Path $taskTarget 'src\mcp.mjs')) -or -not (Test-Path -LiteralPath $taskCapture) -or [IO.Path]::GetFileName($taskCapture) -ne 'ScreenCapture.exe') { throw 'Expected installed source and reviewed ScreenCapture.exe' }
$taskCandidateVersion = (Get-Content -LiteralPath (Join-Path $taskSource 'package.json') -Raw | ConvertFrom-Json).version
if ($taskCandidateVersion -notin @('0.3.0','0.4.0','0.5.0','0.6.0','0.7.0','0.7.1','0.7.2')) { throw 'This updater expects a reviewed source release from 0.3.0 through 0.7.2' }
if ($taskCandidateVersion -in @('0.5.0','0.6.0','0.7.0','0.7.1','0.7.2') -and (-not $HidExecutable -or -not [IO.Path]::IsPathRooted($HidExecutable) -or [IO.Path]::GetFileName($HidExecutable) -ne 'HidTransport.exe' -or -not (Test-Path -LiteralPath $HidExecutable))) { throw 'This version also requires the matching reviewed -HidExecutable' }
# Validate the allowlist before stopping anything.
$taskFiles = @(git -c "safe.directory=$taskSource" -C $taskSource ls-files)
if ($LASTEXITCODE -ne 0 -or $taskFiles.Count -lt 55) { throw 'Run from a complete reviewed Git checkout' }
$taskCommit = (git -c "safe.directory=$taskSource" -C $taskSource rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the reviewed source commit' }
$taskStatusPath = Join-Path $taskData 'live-status.json'
$taskStatus = if (Test-Path -LiteralPath $taskStatusPath) { Get-Content -LiteralPath $taskStatusPath -Raw | ConvertFrom-Json } else { $null }
if ($taskStatus -and $taskStatus.running) {
    if ($taskStatus.clients -ne 0 -or $taskStatus.control.owner -or $taskStatus.activeCaptures -ne 0 -or $taskStatus.recording.state -in @('starting','recording','stopping')) { throw 'Controller is in use. Close all MCP clients first; no update was applied.' }
    if (([DateTime]::UtcNow - [DateTime]::Parse($taskStatus.updatedUtc).ToUniversalTime()).TotalSeconds -gt 3) { throw 'Controller status is stale; inspect it before updating' }
    if ($CheckOnly) { Write-Output 'Controller is idle; no update was applied (CheckOnly).'; return }
    & $taskConfig.nodeExecutable (Join-Path $taskTarget 'src\manage.mjs') stop --data-root $taskData
    if ($LASTEXITCODE -ne 0) { throw 'Normal controller shutdown failed; source was not changed' }
    $taskStopped = $false
    for ($taskAttempt=0; $taskAttempt -lt 50; $taskAttempt++) {
        if (-not (Test-Path -LiteralPath (Join-Path $taskData 'controller\broker.lock'))) { $taskStopped = $true; break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $taskStopped) { throw 'Controller did not finish shutdown; source was not changed' }
} elseif (Test-Path -LiteralPath (Join-Path $taskData 'controller\broker.lock')) { throw 'Inspect the existing controller lock before updating; source was not changed' }
if ($CheckOnly) { Write-Output 'Controller is offline; no update was applied (CheckOnly).'; return }
# Explicit tracked-source allowlist; no local configuration, binaries or recordings.
$taskBackup = Join-Path $taskData ('updates\' + $taskCandidateVersion + '-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '\backup')
[IO.Directory]::CreateDirectory($taskBackup) | Out-Null
$taskEncoding = New-Object System.Text.UTF8Encoding($false)
Copy-Item -LiteralPath $Configuration -Destination (Join-Path $taskBackup 'deployment.local.json')
foreach ($taskRelative in $taskFiles) {
    $taskFrom = [IO.Path]::GetFullPath((Join-Path $taskSource $taskRelative))
    $taskTo = [IO.Path]::GetFullPath((Join-Path $taskTarget $taskRelative))
    if (-not $taskFrom.StartsWith($taskSource + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or -not $taskTo.StartsWith($taskTarget + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source path escaped deployment root' }
    if (Test-Path -LiteralPath $taskTo) {
        $taskSaved = Join-Path $taskBackup $taskRelative
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($taskSaved)) | Out-Null
        Copy-Item -LiteralPath $taskTo -Destination $taskSaved
    }
    if ($taskFrom -ne $taskTo) { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($taskTo)) | Out-Null; Copy-Item -LiteralPath $taskFrom -Destination $taskTo -Force }
    if ((Get-FileHash -LiteralPath $taskFrom).Hash -ne (Get-FileHash -LiteralPath $taskTo).Hash) { throw 'Deployment copy hash mismatch; controller remains stopped' }
}
$taskNativeTarget = Join-Path ([IO.Path]::GetDirectoryName($taskConfig.nativeExecutable)) 'ScreenCapture.exe'
if ($HidExecutable) {
    $taskHidSource=[IO.Path]::GetFullPath($HidExecutable)
    if(Test-Path -LiteralPath $taskConfig.nativeExecutable){Copy-Item -LiteralPath $taskConfig.nativeExecutable -Destination (Join-Path $taskBackup 'HidTransport.exe')}
    if($taskHidSource -ne $taskConfig.nativeExecutable){Copy-Item -LiteralPath $taskHidSource -Destination $taskConfig.nativeExecutable -Force}
    if((Get-FileHash -LiteralPath $taskHidSource).Hash -ne (Get-FileHash -LiteralPath $taskConfig.nativeExecutable).Hash){throw 'HID helper hash mismatch'}
}
if (Test-Path -LiteralPath $taskNativeTarget) { Copy-Item -LiteralPath $taskNativeTarget -Destination (Join-Path $taskBackup 'ScreenCapture.exe') }
if ($taskCapture -ne $taskNativeTarget) { Copy-Item -LiteralPath $taskCapture -Destination $taskNativeTarget -Force }
if ((Get-FileHash -LiteralPath $taskCapture).Hash -ne (Get-FileHash -LiteralPath $taskNativeTarget).Hash) { throw 'Capture binary hash mismatch' }
$taskConfig.mcpVersion = $taskCandidateVersion
$taskConfig | Add-Member -NotePropertyName captureExecutable -NotePropertyValue $taskNativeTarget -Force
$taskConfig | Add-Member -NotePropertyName publicCommit -NotePropertyValue $taskCommit -Force
[IO.File]::WriteAllText([IO.Path]::GetFullPath($Configuration), ($taskConfig | ConvertTo-Json -Depth 12) + [Environment]::NewLine, $taskEncoding)
$taskManifest = @{ capturedUtc=[DateTime]::UtcNow.ToString('o'); sourceRoot=$taskTarget; gitCommit=$taskCommit; sourceState='deployed from reviewed Git source'; files=@($taskFiles | ForEach-Object { @{ path=$_; sha256=(Get-FileHash -LiteralPath (Join-Path $taskTarget $_)).Hash } }) }
[IO.File]::WriteAllText((Join-Path $taskData 'source-manifest.json'), ($taskManifest | ConvertTo-Json -Depth 8), $taskEncoding)
$taskBinaryManifestPath = Join-Path $taskData 'binary-manifest.json'
if (Test-Path -LiteralPath $taskBinaryManifestPath) {
    $taskBinaryManifest = Get-Content -LiteralPath $taskBinaryManifestPath -Raw | ConvertFrom-Json
    $taskBinaryManifest.capturedUtc = [DateTime]::UtcNow.ToString('o')
    $taskBinaryManifest.files = @($taskBinaryManifest.files | Where-Object { $_.path -ne 'native\ScreenCapture.exe' -and (-not $HidExecutable -or $_.path -ne 'native\HidTransport.exe') }) + @(@{ path='native\ScreenCapture.exe'; sha256=(Get-FileHash -LiteralPath $taskNativeTarget).Hash })
    if($HidExecutable){$taskBinaryManifest.files += @(@{path='native\HidTransport.exe';sha256=(Get-FileHash -LiteralPath $taskConfig.nativeExecutable).Hash})}
    [IO.File]::WriteAllText($taskBinaryManifestPath, ($taskBinaryManifest | ConvertTo-Json -Depth 8), $taskEncoding)
}
# Registration path is unchanged. Preserve any operator stop; never call resume.
& $taskConfig.nodeExecutable (Join-Path $taskTarget 'src\manage.mjs') start --live $taskConfig.nativeExecutable --data-root $taskData
if ($LASTEXITCODE -ne 0) { throw "Start failed; inspect logs. Backup: $taskBackup" }
$taskActivated = Get-Content -LiteralPath $taskStatusPath -Raw | ConvertFrom-Json
if ($taskActivated.version -ne $taskCandidateVersion) { throw 'Started controller did not report the expected version; inspect logs before reconnecting' }
if ($taskConfig.availableUpdate) {
    $taskConfig.availableUpdate.activationPending = $false
    $taskConfig.availableUpdate | Add-Member -NotePropertyName activatedUtc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($Configuration), ($taskConfig | ConvertTo-Json -Depth 12) + [Environment]::NewLine, $taskEncoding)
}
$taskVerificationPath = Join-Path $taskData 'status.json'
if (Test-Path -LiteralPath $taskVerificationPath) {
    $taskVerification = Get-Content -LiteralPath $taskVerificationPath -Raw | ConvertFrom-Json
    $taskVerification.version = $taskCandidateVersion; $taskVerification.updatedUtc = [DateTime]::UtcNow.ToString('o')
    $taskVerification.sourceFileCount = $taskFiles.Count
    $taskVerification.javascriptTests = if ($taskCandidateVersion -in @('0.7.0','0.7.1','0.7.2')) { 67 } elseif ($taskCandidateVersion -eq '0.6.0') { 55 } elseif ($taskCandidateVersion -eq '0.5.0') { 46 } elseif ($taskCandidateVersion -eq '0.4.0') { 41 } else { 39 }
    if ($taskVerification.mcp) { $taskVerification.mcp.toolCount = if ($taskCandidateVersion -in @('0.7.0','0.7.1','0.7.2')) { 17 } elseif ($taskCandidateVersion -eq '0.6.0') { 14 } else { 11 } }
    $taskVerification.sourceManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $taskData 'source-manifest.json')).Hash
    if ($taskVerification.availableUpdate) { $taskVerification.availableUpdate.activationPending = $false }
    [IO.File]::WriteAllText($taskVerificationPath, ($taskVerification | ConvertTo-Json -Depth 16), $taskEncoding)
}
Write-Output "Installed $taskCandidateVersion. Reload the MCP connection for current schemas/descriptions. Backup: $taskBackup"
