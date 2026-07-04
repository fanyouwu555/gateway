# AI Gateway API Test Script
$ErrorActionPreference = "Continue"
$BaseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { "http://localhost:3000" }
$AdminApiKey = $env:ADMIN_KEY

if (-not $AdminApiKey) {
    Write-Host "请设置环境变量 ADMIN_KEY 后运行本脚本" -ForegroundColor Red
    Write-Host "示例: `$env:ADMIN_KEY = 'sk-xxxx'; .\api-test-runner.ps1"
    exit 1
}

$TestsPassed = 0
$TestsFailed = 0

function Write-TestResult {
    param($Status, $Message)
    switch ($Status) {
        "PASS" { Write-Host "[PASS] " -NoNewline -ForegroundColor Green; $script:TestsPassed++ }
        "FAIL" { Write-Host "[FAIL] " -NoNewline -ForegroundColor Red; $script:TestsFailed++ }
    }
    Write-Host $Message
}

function Invoke-ApiCall {
    param($Endpoint, $Method = "GET", $Body = $null)
    $url = "$BaseUrl$Endpoint"
    $headers = @{ "Authorization" = "Bearer $AdminApiKey" }
    try {
        if ($Body) {
            $response = Invoke-RestMethod -Uri $url -Method $Method -Body ($Body | ConvertTo-Json) -ContentType "application/json" -Headers $headers -UseBasicParsing -TimeoutSec 30
        } else {
            $response = Invoke-RestMethod -Uri $url -Method $Method -Headers $headers -UseBasicParsing -TimeoutSec 30
        }
        return @{ Success = $true; Data = $response }
    } catch {
        return @{ Success = $false; Error = $_.Exception.Message }
    }
}

Write-Host ""
Write-Host "========================================"
Write-Host "AI Gateway API Test (with Admin Auth)"
Write-Host "========================================"

# Health Check
$result = Invoke-ApiCall "/health"
if ($result.Success) {
    Write-TestResult "PASS" "Health check API response OK"
    Write-Host "  Status: $($result.Data.status)"
    Write-Host "  Version: $($result.Data.version)"
} else {
    Write-TestResult "FAIL" "Health check API failed"
}

# Auth Verify
$result = Invoke-ApiCall "/v1/auth/verify"
if ($result.Success) {
    Write-TestResult "PASS" "Auth verify API response OK"
    Write-Host "  Valid: $($result.Data.valid)"
    Write-Host "  Is Admin: $($result.Data.is_admin)"
} else {
    Write-TestResult "FAIL" "Auth verify API failed - $($result.Error)"
}

# Dashboard Overview
$now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$start = $now - (24 * 60 * 60 * 1000)
$result = Invoke-ApiCall "/v1/usage/overview?start=$start&end=$now"
if ($result.Success) {
    Write-TestResult "PASS" "Dashboard overview API response OK"
    Write-Host "  Total Requests: $($result.Data.total_requests)"
    Write-Host "  Total Tokens: $($result.Data.total_tokens)"
    Write-Host "  Avg Duration: $($result.Data.avg_duration_ms)ms"
} else {
    Write-TestResult "FAIL" "Dashboard overview API failed - $($result.Error)"
}

# Tenant List
$result = Invoke-ApiCall "/v1/tenants"
if ($result.Success) {
    Write-TestResult "PASS" "Tenant list API response OK"
    Write-Host "  Tenant count: $($result.Data.tenants.Count)"
} else {
    Write-TestResult "FAIL" "Tenant list API failed - $($result.Error)"
}

# Create Tenant
$newTenant = @{ name = "TestTenant"; plan = "free"; status = "active" }
$result = Invoke-ApiCall "/v1/tenants" -Method "POST" -Body $newTenant
if ($result.Success) {
    Write-TestResult "PASS" "Create tenant API response OK"
    Write-Host "  Tenant ID: $($result.Data.tenant_id)"
    $testTenantId = $result.Data.tenant_id

    # Delete Tenant
    $result = Invoke-ApiCall "/v1/tenants/$testTenantId" -Method "DELETE"
    if ($result.Success) {
        Write-TestResult "PASS" "Delete tenant API response OK"
    } else {
        Write-TestResult "FAIL" "Delete tenant API failed - $($result.Error)"
    }
} else {
    Write-TestResult "FAIL" "Create tenant API failed - $($result.Error)"
}

# Cache Stats
$result = Invoke-ApiCall "/v1/cache"
if ($result.Success) {
    Write-TestResult "PASS" "Cache stats API response OK"
    if ($result.Data.stats) {
        Write-Host "  Size: $($result.Data.stats.size)"
        Write-Host "  Hit Rate: $([math]::Round($result.Data.stats.hit_rate * 100, 2))%"
    }
} else {
    Write-TestResult "FAIL" "Cache stats API failed - $($result.Error)"
}

# Alert Rules
$result = Invoke-ApiCall "/v1/alerts"
if ($result.Success) {
    Write-TestResult "PASS" "Alert rules API response OK"
    Write-Host "  Rule count: $($result.Data.rules.Count)"
} else {
    Write-TestResult "FAIL" "Alert rules API failed - $($result.Error)"
}

# Prompt Templates
$result = Invoke-ApiCall "/v1/prompts"
if ($result.Success) {
    Write-TestResult "PASS" "Prompt templates API response OK"
    Write-Host "  Template count: $($result.Data.templates.Count)"
} else {
    Write-TestResult "FAIL" "Prompt templates API failed - $($result.Error)"
}

# Plugins
$result = Invoke-ApiCall "/v1/plugins"
if ($result.Success) {
    Write-TestResult "PASS" "Plugins API response OK"
    Write-Host "  Plugin count: $($result.Data.plugins.Count)"
} else {
    Write-TestResult "FAIL" "Plugins API failed - $($result.Error)"
}

# Router Status
$result = Invoke-ApiCall "/v1/router/status"
if ($result.Success) {
    Write-TestResult "PASS" "Router status API response OK"
} else {
    Write-TestResult "FAIL" "Router status API failed - $($result.Error)"
}

# Config
$result = Invoke-ApiCall "/v1/config"
if ($result.Success) {
    Write-TestResult "PASS" "Config API response OK"
} else {
    Write-TestResult "FAIL" "Config API failed - $($result.Error)"
}

# Conversations
$result = Invoke-ApiCall "/v1/conversations?limit=10"
if ($result.Success) {
    Write-TestResult "PASS" "Conversations API response OK"
    Write-Host "  Session count: $($result.Data.sessions.Count)"
} else {
    Write-TestResult "FAIL" "Conversations API failed - $($result.Error)"
}

# Metrics Providers
$result = Invoke-ApiCall "/v1/usage/providers"
if ($result.Success) {
    Write-TestResult "PASS" "Metrics providers API response OK"
    Write-Host "  Provider count: $($result.Data.Count)"
} else {
    Write-TestResult "FAIL" "Metrics providers API failed - $($result.Error)"
}

# Time Series
$result = Invoke-ApiCall "/v1/usage/timeseries?granularity=hour"
if ($result.Success) {
    Write-TestResult "PASS" "Time series API response OK"
    Write-Host "  Data points: $($result.Data.Count)"
} else {
    Write-TestResult "FAIL" "Time series API failed - $($result.Error)"
}

# Usage Tenants
$result = Invoke-ApiCall "/v1/usage/tenants"
if ($result.Success) {
    Write-TestResult "PASS" "Usage tenants API response OK"
    Write-Host "  Tenant count: $($result.Data.Count)"
} else {
    Write-TestResult "FAIL" "Usage tenants API failed - $($result.Error)"
}

Write-Host ""
Write-Host "========================================"
Write-Host "Test Results"
Write-Host "========================================"
Write-Host "Passed: $TestsPassed"
Write-Host "Failed: $TestsFailed"
$total = $TestsPassed + $TestsFailed
if ($total -gt 0) {
    $passRate = [math]::Round(($TestsPassed / $total) * 100, 2)
    Write-Host "Pass Rate: $passRate%"
}
Write-Host "========================================"
