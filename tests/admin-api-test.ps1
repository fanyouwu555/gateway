# Admin API Test with Auth
$baseUrl = "http://localhost:3000"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Admin API Test" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Test 1: Without auth key (should fail)
Write-Host "[1] Test without API key (should fail)" -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$baseUrl/v1/usage/overview" -Method GET -UseBasicParsing -TimeoutSec 5
    Write-Host "    [FAIL] Should have returned 401, but got success" -ForegroundColor Red
} catch {
    if ($_.Exception.Message -match "401" -or $_.Exception.Message -match "Unauthorized") {
        Write-Host "    [OK] Correctly rejected unauthenticated request" -ForegroundColor Green
    } else {
        Write-Host "    [WARN] Got different error: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "  Frontend should be at: http://localhost:3001" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Check these frontend pages:" -ForegroundColor Yellow
Write-Host "    - Dashboard: Real-time metrics and charts" -ForegroundColor Gray
Write-Host "    - Metrics: Provider/tenant usage statistics" -ForegroundColor Gray
Write-Host "    - Tenants: Tenant management (CRUD)" -ForegroundColor Gray
Write-Host "    - Providers: Provider status monitoring" -ForegroundColor Gray
Write-Host ""
