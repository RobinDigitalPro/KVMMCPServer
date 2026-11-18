[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$NativeExecutable,
    [Parameter(Mandatory=$true)][string]$DataRoot,
    [string]$CodexPath = 'codex',
    [string]$Name = 'opendesktophid'
)
$ErrorActionPreference = 'Stop'
foreach($taskPath in @($NodePath,$NativeExecutable,$DataRoot)) { if(-not [IO.Path]::IsPathRooted($taskPath)) { throw 'Node, native executable and data root must be absolute paths' } }
$taskServer = Join-Path $PSScriptRoot '..\src\mcp.mjs'
& $CodexPath mcp add $Name -- $NodePath ([IO.Path]::GetFullPath($taskServer)) --live $NativeExecutable --data-root $DataRoot --agent codex-local
if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration failed' }
Write-Output 'Registered eleven local desktop tools. Reload the MCP connection in the client if its catalog is not refreshed yet.'
