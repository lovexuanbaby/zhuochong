param([string]$Python = '', [string]$DataRoot = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'python-common.ps1')
$interpreter = Find-DeskpetPython $Python $DataRoot
Write-Output "Checking interpreter: $interpreter"
& $interpreter -c 'import sys, json, PySide6; from PySide6.QtWidgets import QApplication; assert sys.version_info >= (3,10), "Python 3.10+ required"; assert PySide6.__version__ == "6.12.0", "Run setup.ps1 to install PySide6 6.12.0"; print(json.dumps({"ok":True,"python":sys.version.split()[0],"pyside6":PySide6.__version__}))'
if ($LASTEXITCODE -ne 0) { throw 'Python/PySide6 check failed. Run scripts/setup.ps1 -Python <python.exe>, then leave the plugin pythonPath blank.' }
Write-Output ('Data root: ' + (Get-DeskpetDataRoot $DataRoot))
