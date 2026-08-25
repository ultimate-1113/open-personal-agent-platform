[CmdletBinding()]
param(
  [ValidateSet("local-dev", "minimal", "cloud-base", "cloud-base-dynamic")]
  [string]$Profile = "cloud-base",
  [switch]$Apply
)

$ErrorActionPreference = "Stop"

$nodeVersion = (& node --version 2>$null)
if (-not $nodeVersion -or $nodeVersion -notmatch '^v(\d+)\.') {
  throw "Node.js 24 LTS or newer is required."
}
if ([int]$Matches[1] -lt 24) {
  throw "Node.js 24 LTS or newer is required. Found $nodeVersion."
}

Write-Host "Installing OPAP dependencies with pnpm 11.23.0..."
& corepack pnpm@11.23.0 install --frozen-lockfile --config.confirmModulesPurge=false
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }

$setupArguments = @("opap", "setup", "--profile", $Profile)
if ($Apply) { $setupArguments += "--apply" }
& corepack pnpm@11.23.0 @setupArguments
if ($LASTEXITCODE -ne 0) { throw "OPAP setup failed." }
