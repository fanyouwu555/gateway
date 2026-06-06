# Simple API Test Script
$baseUrl = "http://localhost:3000"
$pass = 0
$fail = 0

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AI Gateway API Test" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Helper function
function Test-Api {
    param($name, $url)

    Write-Host "  Testing: $name" -ForegroundColor Gray
    try {
        $response = Invoke-RestMethod -Uri $url -Method GET -UseBasicParsing -TimeoutSec 5
        Write-Host "    [OK] PASS" -ForegroundColor Green
        $script:pass++
    } catch {
        Write-Host "    [FAIL] $($_.Exception.Message)" -ForegroundColor Red
        $script:fail++
    }
}

# Public APIs
Write-Host "[1] Public API Tests" -ForegroundColor Yellow
Test-Api "Health Check" "$baseUrl/health"
Test-Api "Root Info" "$baseUrl/"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Pass: $pass" -ForegroundColor Green
Write-Host "  Fail: $fail" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
Write-Host ""

if ($fail -eq 0) {
    Write-Host "  All basic tests passed! Server is running." -ForegroundColor Green
    Write-Host ""
    Write-Host "  Next steps:" -ForegroundColor Yellow
    Write-Host "    1. Visit http://localhost:3001 for frontend" -ForegroundColor Gray
    Write-Host "    2. Check management APIs require admin key" -ForegroundColor Gray
} else {
    Write-Host "  Some tests failed. Make sure backend is running." -ForegroundColor Red
}
Write-Host ""
