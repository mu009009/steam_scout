# Steam 市场侦察兵 · 分享打包脚本
# 生成 steamscout-share-YYYYMMDD.zip（自动排除 .env 中的 API Key）
param([switch]$NoData)   # -NoData：不含 data\（让对方自行播种知识库）

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path (Split-Path $root) ("steamscout-share-" + (Get-Date -Format yyyyMMdd) + ".zip")
$stage = Join-Path $env:TEMP ("steamscout_share_" + [guid]::NewGuid().ToString("N").Substring(0, 8))

Write-Host "== Steam 市场侦察兵 · 分享打包 ==" -ForegroundColor Cyan

# 先将 SQLite WAL 合并进主库（确保知识库最新数据被打包）
if (Test-Path "$root\scripts\checkpoint_db.mjs") {
  & node "$root\scripts\checkpoint_db.mjs"
  if ($LASTEXITCODE -ne 0) { Write-Warning "WAL 合并失败（若服务器正在运行属正常，请先关闭服务器再打包）" }
}

Write-Host "暂存目录: $stage"

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item "$root\*" $stage -Recurse -Force

# 清理：API Key / 临时文件 / 历史打包
Remove-Item "$stage\.env" -Force -ErrorAction SilentlyContinue
Remove-Item "$stage\*.zip" -Force -ErrorAction SilentlyContinue
Remove-Item "$stage\data\*.db-wal", "$stage\data\*.db-shm" -Force -ErrorAction SilentlyContinue
if ($NoData) {
  Remove-Item "$stage\data" -Recurse -Force
  Write-Host "已排除 data\ 目录（接收方需自行运行 node src\ingest\seed.mjs 播种）" -ForegroundColor Yellow
} else {
  # 脱敏：分享包不携带私人对话/反馈/项目档案（保留 UP 主知识库）
  & node "$stage\scripts\sanitize_db.mjs" "$stage\data\scout.db"
  Remove-Item "$stage\scripts\sanitize_db.mjs" -Force
  Remove-Item "$stage\data\*.db-wal", "$stage\data\*.db-shm" -Force -ErrorAction SilentlyContinue
  Write-Host "已包含 data\ 目录（已脱敏：仅知识库，不含私人对话）" -ForegroundColor Green
}

Remove-Item $out -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$stage\*" -DestinationPath $out
Remove-Item $stage -Recurse -Force

$size = [math]::Round((Get-Item $out).Length / 1MB, 2)
Write-Host ""
Write-Host "✅ 打包完成: $out ($size MB)" -ForegroundColor Green
Write-Host ""
Write-Host "分享注意事项:"
Write-Host " 1. 已自动排除 .env（你的 DeepSeek API Key 不会泄露）"
Write-Host " 2. 接收方: 解压后复制 .env.example 为 .env，填入自己的 Key（platform.deepseek.com 免费注册）"
Write-Host " 3. 接收方需要: Node.js 22+（nodejs.org 下载安装，无需 npm install）"
Write-Host " 4. Windows 双击 start.bat；Mac/Linux 在目录里运行 node server.mjs"
Write-Host " 5. 端口冲突: 改 .env 的 PORT 或 config.json 的 port"
