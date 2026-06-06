@echo off
echo ========================================
echo   AI Gateway Test Environment Starter
echo ========================================
echo.

echo Starting Backend (port 3000)...
start "AI Gateway Backend" cmd /k "cd /d d:\AGateWay\GateWay && npm run dev"

echo Waiting for backend to start...
timeout /t 5 /nobreak >nul

echo Starting Frontend (port 3001)...
start "AI Gateway Frontend" cmd /k "cd /d d:\AGateWay\GateWay\ai-gateway-admin && npm run dev"

echo.
echo ========================================
echo   Services Starting!
echo ========================================
echo.
echo Backend:  http://localhost:3000
echo Frontend: http://localhost:3001
echo.
echo Wait 10-15 seconds, then run tests:
echo   .\tests\e2e-api-test.ps1
echo   node tests\websocket-realtime-test.mjs
echo.
pause
