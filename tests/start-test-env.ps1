# AI Gateway 测试环境一键启动脚本
# 使用方法: .\tests\start-test-env.ps1

$ProjectRoot = Split-Path $PSScriptRoot -Parent

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AI Gateway 测试环境启动" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/2] 启动后端服务..." -ForegroundColor Yellow
Write-Host "  后端正在启动 (端口 3000)..." -ForegroundColor Gray
Write-Host "  请在新终端执行: cd d:\AGateWay\GateWay; npm run dev" -ForegroundColor Gray

Write-Host ""
Write-Host "[2/2] 启动前端服务..." -ForegroundColor Yellow
Write-Host "  前端正在启动 (端口 3001)..." -ForegroundColor Gray
Write-Host "  请在新终端执行: cd d:\AGateWay\GateWay\ai-gateway-admin; npm run dev" -ForegroundColor Gray

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  启动步骤说明" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  终端 1 (后端):" -ForegroundColor White
Write-Host "    cd d:\AGateWay\GateWay" -ForegroundColor Gray
Write-Host "    npm run dev" -ForegroundColor Gray
Write-Host ""
Write-Host "  终端 2 (前端):" -ForegroundColor White
Write-Host "    cd d:\AGateWay\GateWay\ai-gateway-admin" -ForegroundColor Gray
Write-Host "    npm run dev" -ForegroundColor Gray
Write-Host ""
Write-Host "  访问地址:" -ForegroundColor White
Write-Host "    后端: http://localhost:3000" -ForegroundColor Gray
Write-Host "    前端: http://localhost:3001" -ForegroundColor Gray
Write-Host ""
Write-Host "  两个服务都启动后, 执行:" -ForegroundColor Yellow
Write-Host "    .\tests\e2e-api-test.ps1    (API 集成测试)" -ForegroundColor Gray
Write-Host "    node tests\websocket-realtime-test.mjs  (WebSocket 测试)" -ForegroundColor Gray
Write-Host ""
