# 环境部署（Windows / 幂等）—— 训练机 Python 环境一键就绪
# 用法: powershell -ExecutionPolicy Bypass -File setup-env.ps1 -WorkRoot D:\hz-yolo [-DryRun]
# -DryRun: 只打印将要执行的安装动作(不改环境)；已有 venv 时仍会跑 check-env.py 复验
param(
  [string]$WorkRoot = "$env:USERPROFILE\hz-detect-trainer",
  [string]$PipIndex = "https://pypi.tuna.tsinghua.edu.cn/simple",
  [string]$TorchIndex = "https://download.pytorch.org/whl/cu128",
  [string]$GithubMirror = "https://ghproxy.net/",
  [string]$PythonExe = "",
  [switch]$SkipTorch,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
function Find-Python {
  if ($PythonExe) { return $PythonExe }
  foreach ($cand in @("py -3.12", "py -3.11", "py -3.10", "python")) {
    try {
      $exe = $cand.Split(" ")[0]; $rest = @($cand.Split(" ")[1..99] | Where-Object { $_ })
      $out = & $exe @rest -c "import sys;print(sys.version_info[0],sys.version_info[1])" 2>$null
      if ($LASTEXITCODE -eq 0) {
        $parts = "$out".Trim().Split(" ")
        if ([int]$parts[0] -ge 3 -and [int]$parts[1] -ge 10) { return $cand }
      }
    } catch {}
  }
  throw "未找到 Python>=3.10，请安装或显式传 -PythonExe"
}
if (Test-Path $WorkRoot) { }
elseif ($DryRun) { Write-Host "(预演) 将创建工作目录 $WorkRoot" }
else { New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null }
$py = Find-Python
Write-Host "[1/6] Python: $py"
$venv = Join-Path $WorkRoot "venv"
$venvReady = Test-Path (Join-Path $venv "Scripts\python.exe")
if ($venvReady) { Write-Host "[2/6] 复用 venv: $venv" }
elseif ($DryRun) { Write-Host "[2/6] (预演) 将创建 venv -> $venv" }
else {
  Write-Host "[2/6] 创建 venv -> $venv"
  $exe = $py.Split(" ")[0]; $rest = @($py.Split(" ")[1..99] | Where-Object { $_ })
  & $exe @rest -m venv $venv
  $venvReady = $true
}
$vpy = Join-Path $venv "Scripts\python.exe"
Write-Host "[3/6] 升级 pip"
if ($DryRun) { Write-Host "  (预演) pip install --upgrade pip -i $PipIndex" }
else { & $vpy -m pip install --upgrade pip -i $PipIndex | Select-Object -Last 1 }
if ($SkipTorch) { Write-Host "[4/6] 跳过 torch (-SkipTorch)" }
elseif ($DryRun) { Write-Host "[4/6] (预演) torch (CUDA 轮子源: $TorchIndex)" }
else {
  Write-Host "[4/6] 安装 torch (CUDA 轮子源: $TorchIndex)"
  & $vpy -m pip install torch --index-url $TorchIndex | Select-Object -Last 2
}
Write-Host "[5/6] 安装 ultralytics / onnx / onnxslim / onnxruntime"
if ($DryRun) { Write-Host "  (预演) pip install ultralytics onnx onnxslim onnxruntime -i $PipIndex" }
else { & $vpy -m pip install ultralytics onnx onnxslim onnxruntime -i $PipIndex | Select-Object -Last 1 }
# 预训练权重（GitHub release 直连常超时，走镜像）
$models = Join-Path $WorkRoot "models"; New-Item -ItemType Directory -Path $models -Force | Out-Null
$wpt = Join-Path $models "yolo11n.pt"
if (-not (Test-Path $wpt)) {
  $url = "${GithubMirror}https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.pt"
  if ($DryRun) { Write-Host "  (预演) 下载 yolo11n.pt -> $wpt (镜像: $GithubMirror)" }
  else {
    Write-Host "  下载 yolo11n.pt (镜像: $GithubMirror)"
    try { Invoke-WebRequest -Uri $url -OutFile $wpt -TimeoutSec 300 } catch { Write-Warning "下载失败，请手工放置到 $wpt（见 references/pitfalls.md 第1条）" }
  }
}
if (Test-Path $wpt) { Write-Host ("  权重: {0} ({1:N1} MB)" -f $wpt, ((Get-Item $wpt).Length / 1MB)) }
Write-Host "[6/6] 环境检测"
if (Test-Path $vpy) { & $vpy (Join-Path $PSScriptRoot "check-env.py") --work-root $WorkRoot --weights $wpt }
else { Write-Host "  (预演) venv 尚未就绪，安装完成后运行 check-env.py 复验" }
Write-Host ""
Write-Host "建议设置: `$env:YOLO_CONFIG_DIR = '$WorkRoot\ultralytics-cfg'  (避免配置写进用户目录)"
Write-Host "训练入口: $vpy <skill>\scripts\train_export.py --data <dataset>\data.yaml --name <run>"
