[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Configuration,
    [Parameter(Mandatory=$true)][string]$CaptureExecutable,
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
if ($taskCandidateVersion -ne '0.3.0') { throw 'This updater expects the reviewed 0.3.0 source' }
# Validate the allowlist before stopping anything.
$taskFiles = @(git -C $taskSource ls-files)
if ($LASTEXITCODE -ne 0 -or $taskFiles.Count -lt 55) { throw 'Run from a complete reviewed Git checkout' }
$taskCommit = (git -C $taskSource rev-parse HEAD).Trim()
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
$taskBackup = Join-Path $taskData ('updates\0.3.0-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '\backup')
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
if (Test-Path -LiteralPath $taskNativeTarget) { Copy-Item -LiteralPath $taskNativeTarget -Destination (Join-Path $taskBackup 'ScreenCapture.exe') }
if ($taskCapture -ne $taskNativeTarget) { Copy-Item -LiteralPath $taskCapture -Destination $taskNativeTarget -Force }
if ((Get-FileHash -LiteralPath $taskCapture).Hash -ne (Get-FileHash -LiteralPath $taskNativeTarget).Hash) { throw 'Capture binary hash mismatch' }
$taskConfig.mcpVersion = '0.3.0'
$taskConfig | Add-Member -NotePropertyName captureExecutable -NotePropertyValue $taskNativeTarget -Force
$taskConfig | Add-Member -NotePropertyName publicCommit -NotePropertyValue $taskCommit -Force
[IO.File]::WriteAllText([IO.Path]::GetFullPath($Configuration), ($taskConfig | ConvertTo-Json -Depth 12) + [Environment]::NewLine, $taskEncoding)
$taskManifest = @{ capturedUtc=[DateTime]::UtcNow.ToString('o'); sourceRoot=$taskTarget; gitCommit=$taskCommit; sourceState='deployed from reviewed Git source'; files=@($taskFiles | ForEach-Object { @{ path=$_; sha256=(Get-FileHash -LiteralPath (Join-Path $taskTarget $_)).Hash } }) }
[IO.File]::WriteAllText((Join-Path $taskData 'source-manifest.json'), ($taskManifest | ConvertTo-Json -Depth 8), $taskEncoding)
$taskBinaryManifestPath = Join-Path $taskData 'binary-manifest.json'
if (Test-Path -LiteralPath $taskBinaryManifestPath) {
    $taskBinaryManifest = Get-Content -LiteralPath $taskBinaryManifestPath -Raw | ConvertFrom-Json
    $taskBinaryManifest.capturedUtc = [DateTime]::UtcNow.ToString('o')
    $taskBinaryManifest.files = @($taskBinaryManifest.files | Where-Object { $_.path -ne 'native\ScreenCapture.exe' }) + @(@{ path='native\ScreenCapture.exe'; sha256=(Get-FileHash -LiteralPath $taskNativeTarget).Hash })
    [IO.File]::WriteAllText($taskBinaryManifestPath, ($taskBinaryManifest | ConvertTo-Json -Depth 8), $taskEncoding)
}
# Registration path is unchanged. Preserve any operator stop; never call resume.
& $taskConfig.nodeExecutable (Join-Path $taskTarget 'src\manage.mjs') start --live $taskConfig.nativeExecutable --data-root $taskData
if ($LASTEXITCODE -ne 0) { throw "Start failed; inspect logs. Backup: $taskBackup" }
$taskActivated = Get-Content -LiteralPath $taskStatusPath -Raw | ConvertFrom-Json
if ($taskActivated.version -ne '0.3.0') { throw 'Started controller did not report version 0.3.0; inspect logs before reconnecting' }
if ($taskConfig.availableUpdate) {
    $taskConfig.availableUpdate.activationPending = $false
    $taskConfig.availableUpdate | Add-Member -NotePropertyName activatedUtc -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($Configuration), ($taskConfig | ConvertTo-Json -Depth 12) + [Environment]::NewLine, $taskEncoding)
}
$taskVerificationPath = Join-Path $taskData 'status.json'
if (Test-Path -LiteralPath $taskVerificationPath) {
    $taskVerification = Get-Content -LiteralPath $taskVerificationPath -Raw | ConvertFrom-Json
    $taskVerification.version = '0.3.0'; $taskVerification.updatedUtc = [DateTime]::UtcNow.ToString('o')
    $taskVerification.sourceFileCount = $taskFiles.Count
    $taskVerification.javascriptTests = 39
    if ($taskVerification.mcp) { $taskVerification.mcp.toolCount = 11 }
    $taskVerification.sourceManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $taskData 'source-manifest.json')).Hash
    if ($taskVerification.availableUpdate) { $taskVerification.availableUpdate.activationPending = $false }
    [IO.File]::WriteAllText($taskVerificationPath, ($taskVerification | ConvertTo-Json -Depth 16), $taskEncoding)
}
Write-Output "Installed 0.3.0. Reload the MCP connection for eleven tools. Backup: $taskBackup"
