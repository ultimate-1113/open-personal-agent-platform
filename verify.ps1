[CmdletBinding()]
param([string]$Directory = ".")
$ErrorActionPreference = "Stop"
$lines = Get-Content -LiteralPath (Join-Path $Directory "SHA256SUMS")
foreach ($line in $lines) {
  if ($line -notmatch '^([a-f0-9]{64})  ([^/\\]+)$') { throw "Invalid checksum line" }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Directory $Matches[2])).Hash.ToLowerInvariant()
  if ($actual -ne $Matches[1]) { throw "Checksum mismatch: $($Matches[2])" }
  Write-Host "verified $($Matches[2])"
}
