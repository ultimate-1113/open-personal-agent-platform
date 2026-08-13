[CmdletBinding()]
param(
  [string]$VariablesFile = ".dev.vars",
  [switch]$IncludeBridge
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $VariablesFile -PathType Leaf)) {
  throw "Secret input file was not found: $VariablesFile"
}

function Read-DotEnvValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $prefix = "$Name="
  $line = Get-Content -LiteralPath $VariablesFile |
    Where-Object { $_.TrimStart().StartsWith($prefix, [StringComparison]::Ordinal) } |
    Select-Object -Last 1

  if ($null -eq $line) {
    return $null
  }

  $value = $line.Trim().Substring($prefix.Length).Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value
}

function Register-WorkerSecret {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$Value,
    [Parameter(Mandatory = $true)]
    [string]$Config
  )

  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "$Name is empty in $VariablesFile"
  }

  $previousCi = $env:CI
  try {
    $env:CI = "true"
    $Value | corepack pnpm@10.28.1 exec wrangler secret put $Name --config $Config
    if ($LASTEXITCODE -ne 0) {
      throw "Wrangler failed to register $Name"
    }
  }
  finally {
    $env:CI = $previousCi
  }
}

$botToken = Read-DotEnvValue -Name "DISCORD_BOT_TOKEN"
Register-WorkerSecret -Name "DISCORD_BOT_TOKEN" -Value $botToken `
  -Config ".wrangler/staging/discord-gatekeeper.jsonc"

if ($IncludeBridge) {
  $bridgeKey = Read-DotEnvValue -Name "DISCORD_BRIDGE_SIGNING_KEY"
  Register-WorkerSecret -Name "DISCORD_BRIDGE_SIGNING_KEY" -Value $bridgeKey `
    -Config ".wrangler/staging/discord-adapter.jsonc"
}

Write-Host "Discord staging secrets were registered without printing their values."
