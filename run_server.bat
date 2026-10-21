@echo off
cd /d "%~dp0"
set MORI_GRPC_ADDR=0.0.0.0:50051
set MORI_GRPC_TOKEN=amelsmash123
echo ========================================
echo Starting Mori Server...
echo Dashboard : http://localhost:3000
echo gRPC Port : 50051
echo Token     : amelsmash123
echo ========================================
target\release\Mori.exe
pause
