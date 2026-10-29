[CmdletBinding()]
param(
  [ValidateSet("local-dev", "minimal", "cloud-base", "cloud-base-dynamic")]
  [string]$Profile = "cloud-base",
  [switch]$Apply
)

$ErrorActionPreference = "Stop"

$nodeVersion = (& node --version 2>$null)
if (-not $nodeVersion -or $nodeVersion -notmatch '^v(\d+)\.(\d+)\.(\d+)$') {
  throw "Node.js 26 LTS (26.13.0 or newer, below 27) is required."
}
$nodeMajor = [int]$Matches[1]
$nodeMinor = [int]$Matches[2]
if ($nodeMajor -ne 26 -or $nodeMinor -lt 13) {
  throw "Node.js 26 LTS (26.13.0 or newer, below 27) is required. Found $nodeVersion."
}

Write-Host "Installing OPAP dependencies with pnpm 11.23.0..."
& npx --yes pnpm@11.23.0 install --frozen-lockfile --config.confirmModulesPurge=false
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }

$setupArguments = @("opap", "setup", "--profile", $Profile)
if ($Apply) { $setupArguments += "--apply" }
& npx --yes pnpm@11.23.0 @setupArguments
if ($LASTEXITCODE -ne 0) { throw "OPAP setup failed." }
