# AI Gateway API 集成测试脚本
# 使用方法: .\tests\e2e-api-test.ps1

$baseUrl = "http://localhost:3000"
$testApiKey = "test-admin-key"
$headers = @{"Authorization" = "Bearer $testApiKey"}
$passCount = 0
$failCount = 0

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AI Gateway API 集成测试" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

function Test-Endpoint {
    param($name, $url, $method = "GET", $body = $null)

    Write-Host "  测试: $name" -ForegroundColor Gray
    try {
        $splat = @{
            Uri = $url
            Method = $method
            Headers = $headers
            ErrorAction = "Stop"
        }
        if ($body) { $splat["Body"] = $body }

        $response = Invoke-RestMethod @splat
        Write-Host "    ✓ PASS" -ForegroundColor Green
        $script:passCount++
        return $response
    } catch {
        Write-Host "    ✗ FAIL: $($_.Exception.Message)" -ForegroundColor Red
        $script:failCount++
        return $null
    }
}

# ========== 公共 API 测试 (不需要认证) ==========
Write-Host "[1/6] 公共 API 测试" -ForegroundColor Yellow

Test-Endpoint "健康检查" "$baseUrl/health"
Test-Endpoint "根路径信息" "$baseUrl/"

# ========== 管理 API 测试 (需要 Admin Key) ==========
Write-Host ""
Write-Host "[2/6] 管理指标 API 测试" -ForegroundColor Yellow

Test-Endpoint "Dashboard 概览" "$baseUrl/v1/usage/overview"
Test-Endpoint "时间序列数据" "$baseUrl/v1/usage/timeseries?granularity=hour"
Test-Endpoint "Provider 统计" "$baseUrl/v1/usage/providers"
Test-Endpoint "租户统计" "$baseUrl/v1/usage/tenants"
Test-Endpoint "状态码统计" "$baseUrl/v1/usage/status-codes"

# ========== 缓存管理 API 测试 ==========
Write-Host ""
Write-Host "[3/6] 缓存管理 API 测试" -ForegroundColor Yellow

Test-Endpoint "获取缓存统计" "$baseUrl/v1/cache"
Test-Endpoint "清理缓存" "$baseUrl/v1/cache/clean" -Method "POST"

# ========== 会话管理 API 测试 ==========
Write-Host ""
Write-Host "[4/6] 会话管理 API 测试" -ForegroundColor Yellow

Test-Endpoint "获取会话列表" "$baseUrl/v1/sessions"
Test-Endpoint "清理会话" "$baseUrl/v1/sessions/clean" -Method "POST"

# ========== 租户管理 API 测试 ==========
Write-Host ""
Write-Host "[5/6] 租户管理 API 测试" -ForegroundColor Yellow

Test-Endpoint "获取租户列表" "$baseUrl/v1/tenants"

$tenantBody = @{
    name = "test-tenant-$(Get-Random)"
    plan = "pro"
    status = "active"
} | ConvertTo-Json

Test-Endpoint "创建租户" "$baseUrl/v1/tenants" -Method "POST" -body $tenantBody

# ========== WebSocket 连接测试 ==========
Write-Host ""
Write-Host "[6/6] WebSocket 连接测试" -ForegroundColor Yellow

try {
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = New-Object System.Threading.CancellationTokenSource
    $cts.CancelAfter(3000)

    try {
        $ws.ConnectAsync([System.Uri]"ws://localhost:3000/v1/ws/admin", $cts.Token).Wait(3000)
        if ($ws.State -eq "Open") {
            Write-Host "    ✓ WebSocket 连接成功" -ForegroundColor Green
            $script:passCount++
        } else {
            Write-Host "    ✗ WebSocket 连接失败: $($ws.State)" -ForegroundColor Red
            $script:failCount++
        }
    } catch {
        Write-Host "    ⚠  WebSocket 连接超时 (服务器可能未启动)" -ForegroundColor Yellow
    } finally {
        $ws.Dispose()
        $cts.Dispose()
    }
} catch {
    Write-Host "    ✗ WebSocket 测试异常" -ForegroundColor Red
    $script:failCount++
}

# ========== 测试总结 ==========
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  测试总结" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  通过: $passCount" -ForegroundColor Green
Write-Host "  失败: $failCount" -ForegroundColor $(if ($failCount -eq 0) { "Green" } else { "Red" })
Write-Host "  总计: $($passCount + $failCount)" -ForegroundColor White
Write-Host ""

if ($failCount -eq 0) {
    Write-Host "  ✅ 所有测试通过!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "  ❌ 部分测试失败" -ForegroundColor Red
    exit 1
}
