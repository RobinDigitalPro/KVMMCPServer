[CmdletBinding()]
param([string]$Configuration = (Join-Path $PSScriptRoot '..\deployment.local.json'))
$ErrorActionPreference = 'Stop'
$taskConfig = Get-Content -LiteralPath $Configuration -Raw | ConvertFrom-Json
if (-not $taskConfig.nodeExecutable) { throw 'Set nodeExecutable in the local deployment configuration' }
& $taskConfig.nodeExecutable (Join-Path $PSScriptRoot '..\src\manage.mjs') start --live $taskConfig.nativeExecutable --data-root $taskConfig.dataRoot
if ($LASTEXITCODE -ne 0) { throw 'Controller startup failed; inspect controller/process.log in the data root' }
