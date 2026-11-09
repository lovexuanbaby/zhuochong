function Get-DeskpetDataRoot([string]$DataRoot) {
    if ($DataRoot) { return [IO.Path]::GetFullPath($DataRoot) }
    if ($env:DSH_HOME) { return [IO.Path]::GetFullPath($env:DSH_HOME) }
    return Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'
}

function Find-DeskpetPython([string]$Python, [string]$DataRoot) {
    if (!$Python) { $Python = $env:DSHPET_PYTHON }
    if ($Python) {
        if (Test-Path -LiteralPath $Python -PathType Leaf) { return (Resolve-Path -LiteralPath $Python).Path }
        $command = Get-Command -Name $Python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { return $command.Source }
        throw "Python interpreter not found: $Python"
    }
    $managed = Join-Path (Get-DeskpetDataRoot $DataRoot) 'deskpet\runtime\Scripts\python.exe'
    if (Test-Path -LiteralPath $managed -PathType Leaf) { return $managed }
    foreach ($name in @('python.exe', 'python3.exe')) {
        $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue |
            Where-Object { $_.Source -notmatch '\\WindowsApps\\' } | Select-Object -First 1
        if ($command) { return $command.Source }
    }
    if ($env:LOCALAPPDATA) {
        $root = Join-Path $env:LOCALAPPDATA 'Programs\Python'
        $versions = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^Python\d+$' } |
            Sort-Object { [int]($_.Name -replace '^Python', '') } -Descending
        foreach ($version in $versions) {
            $candidate = Join-Path $version.FullName 'python.exe'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    throw 'Install Python 3.10+ first, or pass -Python with the full path to python.exe.'
}
