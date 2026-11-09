param([string]$Python = '', [string]$DataRoot = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'python-common.ps1')

$basePython = Find-DeskpetPython $Python $DataRoot
& $basePython -c 'import sys; assert sys.version_info >= (3,10), "Python 3.10+ required"'
if ($LASTEXITCODE -ne 0) { throw 'The selected Python interpreter is not supported.' }
$runtime = Join-Path (Get-DeskpetDataRoot $DataRoot) 'deskpet\runtime'
if ($runtime.Length -gt 80) {
    throw 'The selected data path is too long for the pinned Qt wheel on Windows without long-path support. Use the default user data directory, or a shorter -DataRoot and set pythonPath to the resulting interpreter.'
}
$runtimePython = Join-Path $runtime 'Scripts\python.exe'
if (!(Test-Path -LiteralPath $runtimePython -PathType Leaf)) {
    & $basePython -m venv $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated Python environment.' }
}
$requirements = Join-Path (Split-Path $PSScriptRoot -Parent) 'requirements.txt'
& $runtimePython -m pip install --disable-pip-version-check -r $requirements
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check the pip output and rerun setup.' }
& (Join-Path $PSScriptRoot 'doctor.ps1') -Python $runtimePython -DataRoot $DataRoot
Write-Output "Python environment ready: $runtimePython"
Write-Output 'Install/enable the bundle in DSH. Leave pythonPath blank to use this environment.'
Write-Output 'If DSHPET_PYTHON or an explicit plugin pythonPath is set, that setting takes priority.'
