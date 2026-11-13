param(
    [string]$Git = '',
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$workspace = Split-Path $repoRoot -Parent
$worktree = Join-Path $workspace '.selfimprove-worktree'
$nodeModules = Join-Path $repoRoot 'node_modules'

if (-not $Git) {
    $Git = Join-Path $workspace '.tools\mingit\cmd\git.exe'
}
if (-not (Test-Path $Git)) {
    throw "找不到 git：$Git（可用 -Git 指定）"
}
if (-not (Test-Path $nodeModules)) {
    throw "主仓库缺少 node_modules，请先在 zhuochong 里执行 pnpm install"
}

"仓库: $repoRoot"
"沙盒: $worktree"

if (Test-Path $worktree) {
    if (-not $Force) {
        "沙盒已存在（加 -Force 重建）"
        exit 0
    }
    & $Git -C $repoRoot worktree remove $worktree --force 2>$null
    if (Test-Path $worktree) { Remove-Item $worktree -Recurse -Force }
    & $Git -C $repoRoot worktree prune 2>$null
}

& $Git -C $repoRoot worktree add $worktree -b selfimprove
if (-not (Test-Path (Join-Path $worktree 'index.js'))) {
    throw 'worktree 创建失败'
}

if (-not (Test-Path (Join-Path $worktree 'node_modules'))) {
    New-Item -ItemType Junction -Path (Join-Path $worktree 'node_modules') -Target $nodeModules | Out-Null
}

"沙盒就绪。"
"  评测：cd `"$worktree`"; node selfimprove\evaluate.mjs"
"  查看改动：git -C `"$worktree`" diff"
"  批准合并：git -C `"$repoRoot`" merge selfimprove"
