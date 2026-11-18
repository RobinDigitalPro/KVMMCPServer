[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$taskSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskConfig = Get-Content -LiteralPath (Join-Path $taskSource 'deployment.local.json') -Raw | ConvertFrom-Json
$taskReceiptDirectory = Join-Path $taskConfig.dataRoot 'installation'
[IO.Directory]::CreateDirectory($taskReceiptDirectory) | Out-Null
$taskReceiptPath = Join-Path $taskReceiptDirectory 'latest.json'
$taskLogPath = Join-Path $taskReceiptDirectory 'install.txt'
$taskReceipt = [ordered]@{ startedUtc=[DateTime]::UtcNow.ToString('o'); status='starting'; inputTested=$false; package=$taskConfig.signedPackage }
$taskReceipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $taskReceiptPath -Encoding utf8
$taskExit = 0
try {
    $taskOutput = @(& (Join-Path $PSScriptRoot 'Install-Local.ps1') *>&1 | Tee-Object -FilePath $taskLogPath)
    $taskResult = $taskOutput | Where-Object { $_ -is [psobject] -and $_.PSObject.Properties['DriverInstalled'] } | Select-Object -Last 1
    if (-not $taskResult -or -not $taskResult.DriverInstalled) { throw 'Installer returned no successful installation result' }
    $taskReceipt.status = 'install_command_succeeded'
    $taskReceipt.rebootRequired = $taskResult.RebootRequired
} catch {
    $taskExit = 1
    $taskReceipt.status = 'failed'
    $taskReceipt.error = $_.Exception.Message
    $_ | Out-String | Add-Content -LiteralPath $taskLogPath
} finally {
    $taskReceipt.finishedUtc = [DateTime]::UtcNow.ToString('o')
    $taskReceipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $taskReceiptPath -Encoding utf8
}
exit $taskExit
