[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [ValidateSet('all','relative','absolute','keyboard','session','mcp','native')][string]$Function = 'all',
    [string]$NodePath = 'node'
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($DataRoot)) { throw 'DataRoot must be absolute' }
$taskSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskData = [IO.Path]::GetFullPath($DataRoot)
if ($taskData -eq $taskSource -or $taskData.StartsWith($taskSource + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test data must live outside source/setup' }
$taskRun = Join-Path $taskData ('tests\' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
[IO.Directory]::CreateDirectory($taskRun) | Out-Null
$env:HID_TEST_ROOT = $taskRun
$taskTimer = [Diagnostics.Stopwatch]::StartNew()
$taskSummary = [ordered]@{ function=$Function; source=$taskSource; startedUtc=[DateTime]::UtcNow.ToString('o'); inputSent=$false; javascript=$null; native=$null; probe=$null; status='running' }
try {
    if ($Function -ne 'native') {
        $taskArgs = @('--test')
        if ($Function -in @('relative','absolute','keyboard')) { $taskArgs += "--test-name-pattern=$Function"; $taskArgs += (Join-Path $taskSource 'test\reports.test.mjs') }
        elseif ($Function -eq 'session') { $taskArgs += (Join-Path $taskSource 'test\session.test.mjs') }
        elseif ($Function -eq 'mcp') { $taskArgs += (Join-Path $taskSource 'test\mcp.test.mjs') }
        else { $taskArgs += (Get-ChildItem -LiteralPath (Join-Path $taskSource 'test') -Filter '*.test.mjs').FullName }
        & $NodePath @taskArgs 2>&1 | Tee-Object -FilePath (Join-Path $taskRun 'javascript.txt')
        if ($LASTEXITCODE -ne 0) { throw "JavaScript tests failed: $LASTEXITCODE" }
        $taskSummary.javascript = 'passed'
    }
    if ($Function -in @('all','native')) {
        $taskNativeDir = Join-Path $taskData 'native'
        & (Join-Path $PSScriptRoot 'Build-Native.ps1') -OutputDirectory $taskNativeDir 2>&1 | Tee-Object -FilePath (Join-Path $taskRun 'native-build.txt')
        $taskSummary.native = 'passed'
        $taskProbe = & (Join-Path $taskNativeDir 'HidTransport.exe') probe
        if ($LASTEXITCODE -ne 0) { throw 'Native probe failed' }
        $taskProbe | Set-Content -LiteralPath (Join-Path $taskRun 'probe.json') -Encoding utf8
        $taskSummary.probe = $taskProbe | ConvertFrom-Json
    }
    $taskSummary.status = 'passed'
} catch {
    $taskSummary.status = 'failed'; $taskSummary.error = $_.Exception.Message
    throw
} finally {
    $taskTimer.Stop(); $taskSummary.durationMs = $taskTimer.ElapsedMilliseconds
    $taskSummary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskRun 'summary.json') -Encoding utf8
    Write-Output "Test results: $taskRun"
}
