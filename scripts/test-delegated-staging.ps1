param(
  [string]$BaseUrl = "https://opap-delegated-staging.lfantian708.workers.dev",
  [string]$SourceId = "source:delegated-github-test",
  [string]$Query = "README"
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repoRoot = Split-Path -Parent $PSScriptRoot
$varsPath = Join-Path $repoRoot ".dev.vars"
if (-not (Test-Path -LiteralPath $varsPath)) {
  throw ".dev.vars was not found."
}

$values = @{}
foreach ($line in Get-Content -LiteralPath $varsPath) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') {
    $values[$matches[1]] = $matches[2].Trim()
  }
}
$token = $values["DELEGATED_TEST_JWT"]
if ([string]::IsNullOrWhiteSpace($token)) {
  throw "DELEGATED_TEST_JWT is not configured."
}

$headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }

function Invoke-JsonPost([string]$Uri, [object]$Body) {
  $json = $Body | ConvertTo-Json -Depth 10 -Compress
  try {
    $response = Invoke-WebRequest -Uri $Uri -Method Post -Headers $headers -Body $json -UseBasicParsing
    $status = [int]$response.StatusCode
    $content = $response.Content
  } catch {
    if ($null -eq $_.Exception.Response) { throw }
    $status = [int]$_.Exception.Response.StatusCode
    $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
  }
  $parsed = if ([string]::IsNullOrWhiteSpace($content)) { $null }
    else { $content | ConvertFrom-Json }
  return [pscustomobject]@{ Status = $status; Body = $parsed }
}

$search = Invoke-JsonPost "$BaseUrl/v1/query" @{
  sourceId = $SourceId; query = $Query; mode = "search"; maxSources = 5
}
if ($search.Status -ne 200 -or $search.Body.mode -ne "search" -or $search.Body.results.Count -lt 1) {
  throw "Delegated REST search failed or returned no results (status $($search.Status))."
}

$mcp = Invoke-JsonPost "$BaseUrl/mcp" @{
  jsonrpc = "2.0"; id = 1; method = "tools/call"; params = @{
    name = "search_knowledge"; arguments = @{
      sourceId = $SourceId; query = $Query; maxSources = 5
    }
  }
}
$mcpResults = $mcp.Body.result.structuredContent.results
if ($mcp.Status -ne 200 -or $mcpResults.Count -lt 1) {
  throw "Delegated MCP search failed or returned no results (status $($mcp.Status))."
}

$denied = Invoke-JsonPost "$BaseUrl/v1/query" @{
  sourceId = "source:not-authorized"; query = $Query; mode = "search"; maxSources = 5
}
if ($denied.Status -ne 403 -or $denied.Body.title -ne "DELEGATED_ACL_DENIED") {
  throw "Unknown or unauthorized source was not denied."
}

[pscustomobject]@{
  rest = "ok"
  restResults = $search.Body.results.Count
  restFirstUri = $search.Body.results[0].uri
  mcp = "ok"
  mcpResults = $mcpResults.Count
  unauthorizedSource = "denied"
} | ConvertTo-Json -Depth 5
