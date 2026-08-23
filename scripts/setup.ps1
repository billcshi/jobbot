#Requires -Version 5.1

<#
.SYNOPSIS
Sets up JobBot on Windows.

.DESCRIPTION
Checks Node.js and pnpm, installs PDF tooling and Python PDF libraries, installs
Node.js dependencies, initializes JobBot's local SQLite database, and runs
post-install verification.

.PARAMETER SkipSystemDependencies
Skips MiKTeX, Poppler, Python, and Python PDF-library installation. Use this when you
only need the web UI and do not need PDF rendering or visual audits yet.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1

.EXAMPLE
.\scripts\setup.ps1 -SkipSystemDependencies
#>

[CmdletBinding()]
param(
    [switch]$SkipSystemDependencies,

    [Parameter(DontShow = $true)]
    [switch]$LoadFunctionsOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PinnedPnpmVersion = '10.15.1'

function Write-Step {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    Write-Host ""
    Write-Host $Message -ForegroundColor Cyan
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
    }
}

function Test-CommandAvailable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Update-SessionPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($env:Path, $machinePath, $userPath) -join ';'
}

function Add-DirectoryToSessionPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory
    )

    try {
        $isDirectory = Test-Path -LiteralPath $Directory -PathType Container -ErrorAction Stop
    }
    catch [System.UnauthorizedAccessException] {
        Write-Verbose "Skipping inaccessible PATH candidate: $Directory"
        return
    }
    if (-not $isDirectory) {
        return
    }
    $pathEntries = @($env:Path -split ';' | Where-Object { $_ })
    if ($pathEntries -notcontains $Directory) {
        $env:Path = @($Directory, $env:Path) -join ';'
    }
}

function Resolve-PdfToolPaths {
    Update-SessionPath

    $miKTeXCandidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\MiKTeX\miktex\bin\x64'),
        (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'MiKTeX\miktex\bin\x64')
    )
    foreach ($directory in $miKTeXCandidates) {
        Add-DirectoryToSessionPath -Directory $directory
    }

    $wingetPackagesRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    $canReadWinGetPackages = $false
    try {
        $canReadWinGetPackages = Test-Path -LiteralPath $wingetPackagesRoot `
            -PathType Container -ErrorAction Stop
    }
    catch [System.UnauthorizedAccessException] {
        Write-Verbose "Cannot inspect WinGet package directory: $wingetPackagesRoot"
    }
    if ($canReadWinGetPackages) {
        $popplerPackages = Get-ChildItem -LiteralPath $wingetPackagesRoot -Directory `
            -Filter 'oschwartz10612.Poppler_*' -ErrorAction SilentlyContinue
        foreach ($package in $popplerPackages) {
            $releases = Get-ChildItem -LiteralPath $package.FullName -Directory `
                -Filter 'poppler-*' -ErrorAction SilentlyContinue
            foreach ($release in $releases) {
                Add-DirectoryToSessionPath -Directory (Join-Path $release.FullName 'Library\bin')
            }
        }
    }
}

function Install-MiKTeXTemplatePackages {
    $miKTeX = Get-Command 'miktex' -ErrorAction SilentlyContinue
    if ($null -eq $miKTeX) {
        Write-Host '  Non-MiKTeX LaTeX installation detected; package provisioning is managed externally.'
        return
    }

    $packages = @(
        'preprint',
        'titlesec',
        'marvosym',
        'graphics',
        'enumitem',
        'hyperref',
        'fancyhdr',
        'babel-english',
        'latex-tools',
        'lato',
        'fontawesome5'
    )
    Write-Host '  Ensuring JobBot MiKTeX template packages are installed...'
    Invoke-CheckedCommand -FilePath $miKTeX.Source -Arguments (@('packages', 'require') + $packages)
}

function Test-LaTeXTemplateDependencies {
    $pdfLaTeX = Get-Command 'pdflatex' -ErrorAction SilentlyContinue
    if ($null -eq $pdfLaTeX) {
        throw 'pdflatex is unavailable for the LaTeX smoke test.'
    }

    $smokeDirectory = Join-Path ([IO.Path]::GetTempPath()) ("jobbot-latex-smoke-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $smokeDirectory | Out-Null
    $smokeTex = Join-Path $smokeDirectory 'smoke.tex'
    $smokePdf = Join-Path $smokeDirectory 'smoke.pdf'
    $source = @'
\documentclass[letterpaper,11pt]{article}
\usepackage{latexsym}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage[usenames,dvipsnames]{color}
\usepackage{verbatim}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage[english]{babel}
\usepackage{tabularx}
\usepackage[default]{lato}
\usepackage{fontawesome5}
\begin{document}
\textbf{JobBot LaTeX smoke test}
\end{document}
'@
    [IO.File]::WriteAllText($smokeTex, $source)

    try {
        Invoke-CheckedCommand -FilePath $pdfLaTeX.Source -Arguments @(
            '-interaction=nonstopmode',
            '-halt-on-error',
            "-output-directory=$smokeDirectory",
            $smokeTex
        )
        if (-not (Test-Path -LiteralPath $smokePdf -PathType Leaf)) {
            throw 'LaTeX smoke test completed without producing a PDF.'
        }
        Write-Host '  JobBot LaTeX template dependency smoke test passed'
    }
    finally {
        if (Test-Path -LiteralPath $smokeDirectory) {
            Remove-Item -LiteralPath $smokeDirectory -Recurse -Force
        }
    }
}

function Enable-CompatiblePnpm {
    if (-not (Test-CommandAvailable -Name 'corepack')) {
        throw 'pnpm 10 or newer is required and Corepack is unavailable. Install pnpm from https://pnpm.io/installation and run this script again.'
    }

    Write-Host "  Installing pinned pnpm $PinnedPnpmVersion with Corepack..."
    Invoke-CheckedCommand -FilePath 'corepack' -Arguments @('prepare', "pnpm@$PinnedPnpmVersion", '--activate')
    Invoke-CheckedCommand -FilePath 'corepack' -Arguments @('enable', 'pnpm')
    Update-SessionPath
}

function Get-PnpmVersion {
    if (-not (Test-CommandAvailable -Name 'pnpm')) {
        return $null
    }

    Push-Location ([IO.Path]::GetTempPath())
    try {
        $version = (& pnpm --version 2> $null)
        if ($LASTEXITCODE -ne 0) {
            return $null
        }
        return $version.Trim()
    }
    finally {
        Pop-Location
    }
}

function Install-WinGetPackage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Id,

        [Parameter(Mandatory = $true)]
        [string]$DisplayName
    )

    Write-Host "  Installing $DisplayName with WinGet..."
    Invoke-CheckedCommand -FilePath 'winget' -Arguments @(
        'install',
        '--id', $Id,
        '--exact',
        '--source', 'winget',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--silent',
        '--disable-interactivity'
    )
    Update-SessionPath
}

function Find-PythonCommand {
    if (Test-CommandAvailable -Name 'python') {
        & python -c 'import sys; print(sys.executable)' *> $null
        if ($LASTEXITCODE -eq 0) {
            return @('python')
        }
    }

    if (Test-CommandAvailable -Name 'py') {
        & py -3 -c 'import sys; print(sys.executable)' *> $null
        if ($LASTEXITCODE -eq 0) {
            return @('py', '-3')
        }
    }

    return @()
}

function Invoke-Python {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$PythonCommand,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $executable = $PythonCommand[0]
    $prefixArguments = @()
    if ($PythonCommand.Count -gt 1) {
        $prefixArguments = $PythonCommand[1..($PythonCommand.Count - 1)]
    }

    Invoke-CheckedCommand -FilePath $executable -Arguments @($prefixArguments + $Arguments)
}

function Test-PythonPdfLibraries {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$PythonCommand
    )

    $executable = $PythonCommand[0]
    $prefixArguments = @()
    if ($PythonCommand.Count -gt 1) {
        $prefixArguments = $PythonCommand[1..($PythonCommand.Count - 1)]
    }

    # Windows PowerShell 5.1 can promote a native program's stderr to a
    # terminating NativeCommandError when $ErrorActionPreference is Stop.
    # Missing imports are an expected probe result here, so decide by exit code.
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $executable @prefixArguments -c 'import fitz, reportlab, pdfplumber, pypdf' *> $null
        return $LASTEXITCODE -eq 0
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Install-PythonPdfLibraries {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$PythonCommand,

        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot
    )

    $pythonVenv = Join-Path $RepositoryRoot 'local\python-venv'
    $venvPython = Join-Path $pythonVenv 'Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        Write-Host '  Creating isolated Python environment in local/python-venv...'
        Invoke-Python -PythonCommand $PythonCommand -Arguments @('-m', 'venv', $pythonVenv)
    }
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        throw 'Python virtual environment creation completed without producing Scripts\python.exe.'
    }

    $venvCommand = @($venvPython)
    Write-Host '  Installing hash-locked Python PDF libraries...'
    Invoke-Python -PythonCommand $venvCommand -Arguments @(
        '-m', 'pip', 'install', '--quiet', '--only-binary=:all:', '--require-hashes',
        '-r', (Join-Path $RepositoryRoot 'requirements-pdf.lock')
    )
    if (-not (Test-PythonPdfLibraries -PythonCommand $venvCommand)) {
        throw 'Python PDF libraries failed their import check inside local/python-venv.'
    }

    return $venvCommand
}

if ($LoadFunctionsOnly) {
    return
}

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location $repositoryRoot

try {
    Write-Host '=== JobBot Setup for Windows ===' -ForegroundColor White

    Write-Step '[1/5] Checking prerequisites...'

    if (-not (Test-CommandAvailable -Name 'node')) {
        throw 'Node.js is not installed. Install Node.js 20 or newer from https://nodejs.org/ and run this script again.'
    }

    $nodeVersion = (& node --version).Trim()
    if ($nodeVersion -notmatch '^v(?<major>\d+)\.') {
        throw "Could not determine the installed Node.js version: $nodeVersion"
    }
    if ([int]$Matches.major -lt 20) {
        throw "Node.js 20 or newer is required; found $nodeVersion."
    }
    Write-Host "  Node.js $nodeVersion"

    $pnpmVersion = Get-PnpmVersion
    $pnpmMajor = $null
    if ($null -ne $pnpmVersion -and $pnpmVersion -match '^(?<major>\d+)\.') {
        $pnpmMajor = [int]$Matches['major']
    }

    if ($pnpmVersion -ne $PinnedPnpmVersion) {
        Enable-CompatiblePnpm
        $pnpmVersion = Get-PnpmVersion
        if ($null -ne $pnpmVersion -and $pnpmVersion -match '^(?<major>\d+)\.') {
            $pnpmMajor = [int]$Matches['major']
        }
    }
    if ($pnpmVersion -ne $PinnedPnpmVersion) {
        throw 'Corepack completed, but pnpm is still unavailable. Open a new PowerShell window and run this script again.'
    }
    Write-Host "  pnpm $pnpmVersion"

    Write-Step '[2/5] Checking system dependencies...'

    if ($SkipSystemDependencies) {
        Write-Warning 'System dependencies skipped. Resume PDF rendering and visual audits may be unavailable.'
    }
    else {
        Resolve-PdfToolPaths
        $needsMiKTeX = -not (Test-CommandAvailable -Name 'pdflatex')
        $needsPoppler = @(
            @('pdftoppm', 'pdfinfo', 'pdftotext') |
                Where-Object { -not (Test-CommandAvailable -Name $_) }
        )
        $pythonCommand = @(Find-PythonCommand)
        $needsPython = $pythonCommand.Count -eq 0

        if (($needsMiKTeX -or $needsPoppler.Count -gt 0 -or $needsPython) -and -not (Test-CommandAvailable -Name 'winget')) {
            throw 'WinGet is required to install missing system dependencies. Install App Installer from the Microsoft Store, or rerun with -SkipSystemDependencies.'
        }

        if ($needsMiKTeX) {
            Install-WinGetPackage -Id 'MiKTeX.MiKTeX' -DisplayName 'MiKTeX (LaTeX)'
        }
        else {
            Write-Host '  pdflatex already installed'
        }

        if ($needsPoppler.Count -gt 0) {
            Install-WinGetPackage -Id 'oschwartz10612.Poppler' -DisplayName 'Poppler'
        }
        else {
            Write-Host '  pdftoppm already installed'
        }

        Resolve-PdfToolPaths
        Install-MiKTeXTemplatePackages
        Test-LaTeXTemplateDependencies

        if ($needsPython) {
            Install-WinGetPackage -Id 'Python.Python.3.13' -DisplayName 'Python 3.13'
            $pythonCommand = @(Find-PythonCommand)
        }
        else {
            Write-Host "  Python command: $($pythonCommand -join ' ')"
        }

        if ($pythonCommand.Count -eq 0) {
            throw 'Python was installed but is not visible in this PowerShell session. Open a new PowerShell window and run this script again.'
        }

        $pythonCommand = @(Install-PythonPdfLibraries `
            -PythonCommand $pythonCommand `
            -RepositoryRoot $repositoryRoot)
    }

    Write-Step '[3/5] Installing Node.js dependencies...'
    Invoke-CheckedCommand -FilePath 'pnpm' -Arguments @('install', '--frozen-lockfile')

    Write-Step '[4/5] Initializing JobBot...'
    Invoke-CheckedCommand -FilePath 'pnpm' -Arguments @('jobbot', 'init-db')

    Write-Step '[5/5] Verifying installation...'
    Invoke-CheckedCommand -FilePath 'pnpm' -Arguments @('typecheck')
    Invoke-CheckedCommand -FilePath 'pnpm' -Arguments @('test')
    if (-not $SkipSystemDependencies) {
        Resolve-PdfToolPaths
        foreach ($command in @('pdflatex', 'pdftoppm', 'pdfinfo', 'pdftotext')) {
            if (-not (Test-CommandAvailable -Name $command)) {
                throw "$command was installed but is not available after resolving the WinGet installation paths."
            }
        }
        if (-not (Test-PythonPdfLibraries -PythonCommand $pythonCommand)) {
            throw 'Python PDF libraries failed their import check.'
        }
        Write-Host '  LaTeX, Poppler, and Python PDF libraries verified'
    }
    Write-Host '  TypeScript and automated tests passed'

    Write-Host ''
    Write-Host '=== Setup complete ===' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Next steps:'
    Write-Host '  1. Start the UI:  pnpm jobbot ui'
    Write-Host '  2. Open:          http://localhost:3000'
    Write-Host '  3. Ask your AI coding agent to interview you and create your profile.'
}
finally {
    Pop-Location
}
