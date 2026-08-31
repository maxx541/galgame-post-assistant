# 貼文工作台啟動腳本
# 由 啟動.bat 呼叫。用 PowerShell 而不是純批次檔，是因為 cmd 讀 UTF-8 批次檔
# 又中途 chcp 會讓位元組位移跑掉，中文訊息會變亂碼、甚至被當成指令執行。

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Url = 'http://localhost:4321/'

# 讓子行程（node）的 UTF-8 輸出能正確顯示
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
    chcp 65001 > $null
} catch { }

$Host.UI.RawUI.WindowTitle = '貼文工作台'
Set-Location $Root

Write-Host ''
Write-Host '  貼文工作台' -ForegroundColor Cyan
Write-Host "  $Root" -ForegroundColor DarkGray
Write-Host ''

# 確認 Node 在不在
try {
    $nodeVer = (& node -v) 2>$null
    Write-Host "  Node $nodeVer" -ForegroundColor DarkGray
} catch {
    Write-Host '  找不到 Node.js。請先安裝：https://nodejs.org/' -ForegroundColor Red
    Write-Host ''
    Read-Host '  按 Enter 關閉'
    exit 1
}

# 第一次啟動要裝相依套件
if (-not (Test-Path (Join-Path $Root 'web\node_modules'))) {
    Write-Host '  第一次啟動，安裝相依套件中，請稍候…' -ForegroundColor Yellow
    & npm --prefix web install
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host '  安裝失敗。檢查網路後再試一次。' -ForegroundColor Red
        Read-Host '  按 Enter 關閉'
        exit 1
    }
}

# 背景等伺服器起來，起來就自動開瀏覽器
$opener = Start-Job -ArgumentList $Url -ScriptBlock {
    param($u)
    for ($i = 0; $i -lt 150; $i++) {
        Start-Sleep -Milliseconds 800
        try {
            Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 2 | Out-Null
            Start-Process $u
            return $true
        } catch { }
    }
    return $false
}

Write-Host "  啟動中… 好了會自動開瀏覽器（$Url）" -ForegroundColor Green
Write-Host '  下面會即時顯示後台在做什麼；瀏覽器裡的「記錄」頁可以看完整內容。' -ForegroundColor DarkGray
Write-Host '  要關閉：按 Ctrl+C 或直接關掉這個視窗。' -ForegroundColor DarkGray
Write-Host ''

try {
    & npm --prefix web run dev
} finally {
    Stop-Job $opener -ErrorAction SilentlyContinue
    Remove-Job $opener -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '  伺服器已停止。' -ForegroundColor Yellow
Read-Host '  按 Enter 關閉'
