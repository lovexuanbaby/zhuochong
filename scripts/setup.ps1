param([string]$Python = '', [string]$DataRoot = '', [string]$PipIndex = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'python-common.ps1')

$basePython = Find-DeskpetPython $Python $DataRoot
& $basePython -c 'import sys; assert sys.version_info >= (3,10), "Python 3.10+ required"'
if ($LASTEXITCODE -ne 0) { throw 'The selected Python interpreter is not supported.' }
$runtime = Join-Path (Get-DeskpetDataRoot $DataRoot) 'deskpet\runtime'
if ($runtime.Length -gt 80 -and !(Test-DeskpetLongPathsEnabled)) {
    throw 'The selected data path is too long for the pinned Qt wheel on this machine: long-path support is disabled and the venv root exceeds 80 characters. Use the default user data directory, or a shorter -DataRoot plus a matching pythonPath. Enabling LongPathsEnabled would also allow it, but setup never changes that policy for you.'
}
$runtimePython = Join-Path $runtime 'Scripts\python.exe'
if (!(Test-Path -LiteralPath $runtimePython -PathType Leaf)) {
    & $basePython -m venv $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated Python environment. Confirm the selected interpreter was installed with pip and venv support.' }
}
$requirements = Join-Path (Split-Path $PSScriptRoot -Parent) 'requirements.txt'
if (!$PipIndex) { $PipIndex = $env:DSHPET_PIP_INDEX }
$pipArgs = @('-m', 'pip', 'install', '--disable-pip-version-check')
if ($PipIndex) { $pipArgs += @('--index-url', $PipIndex) }
$pipArgs += @('-r', $requirements)
& $runtimePython @pipArgs
if ($LASTEXITCODE -ne 0) {
    if ($PipIndex) {
        throw "Dependency installation failed using index $PipIndex. Check the pip output above."
    }
    throw 'Dependency installation failed. The pinned Qt wheel is large; if the default index is slow or blocked, rerun with a mirror, e.g.: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -PipIndex https://pypi.tuna.tsinghua.edu.cn/simple'
}
& (Join-Path $PSScriptRoot 'doctor.ps1') -Python $runtimePython -DataRoot $DataRoot
Write-Output "Python environment ready: $runtimePython"
Write-Output 'Install/enable the bundle in DSH. Leave pythonPath blank to use this environment.'
Write-Output 'If DSHPET_PYTHON or an explicit plugin pythonPath is set, that setting takes priority.'
