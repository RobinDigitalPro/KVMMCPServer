[CmdletBinding()]
param([switch]$Emergency, [string]$Configuration = (Join-Path $PSScriptRoot '..\deployment.local.json'))
$ErrorActionPreference = 'Stop'
$taskConfig = Get-Content -LiteralPath $Configuration -Raw | ConvertFrom-Json
if (-not $taskConfig.nodeExecutable) { throw 'Set nodeExecutable in the local deployment configuration' }
$taskAction = if ($Emergency) { 'emergency-stop' } else { 'stop' }
& $taskConfig.nodeExecutable (Join-Path $PSScriptRoot '..\src\manage.mjs') $taskAction --data-root $taskConfig.dataRoot
if ($LASTEXITCODE -ne 0) { throw 'Controller stop failed' }
