[CmdletBinding()]
param(
    [string]$Version = "0.1.0-beta.3",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseRoot = Join-Path $repoRoot "target\release"
$packageName = "CCSM-$Version-windows-x64"
$stageRoot = Join-Path $releaseRoot "package\$packageName"
$zipPath = Join-Path $releaseRoot "$packageName.zip"

if (-not $SkipBuild) {
    Push-Location $repoRoot
    try {
        pnpm desktop:build:release
        if ($LASTEXITCODE -ne 0) {
            throw "Windows release build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

$requiredPaths = @(
    (Join-Path $releaseRoot "ccsm-desktop.exe"),
    (Join-Path $releaseRoot "conpty\herdr-conpty.json"),
    (Join-Path $releaseRoot "conpty\conpty.dll"),
    (Join-Path $releaseRoot "conpty\x64\OpenConsole.exe"),
    (Join-Path $releaseRoot "conpty\arm64\OpenConsole.exe"),
    (Join-Path $releaseRoot "THIRD-PARTY-NOTICES\Microsoft.Windows.Console.ConPTY-LICENSE.txt"),
    (Join-Path $releaseRoot "THIRD-PARTY-NOTICES\Microsoft.Windows.Console.ConPTY-NOTICE.md")
)
foreach ($path in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing release artifact: $path"
    }
}

if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Path $stageRoot | Out-Null
$noticeRoot = New-Item -ItemType Directory -Path (Join-Path $stageRoot "THIRD-PARTY-NOTICES")
Copy-Item -LiteralPath (Join-Path $releaseRoot "ccsm-desktop.exe") -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $releaseRoot "conpty") -Destination $stageRoot -Recurse
Copy-Item -LiteralPath (Join-Path $releaseRoot "THIRD-PARTY-NOTICES\Microsoft.Windows.Console.ConPTY-LICENSE.txt") -Destination $noticeRoot
Copy-Item -LiteralPath (Join-Path $releaseRoot "THIRD-PARTY-NOTICES\Microsoft.Windows.Console.ConPTY-NOTICE.md") -Destination $noticeRoot
Copy-Item -LiteralPath (Join-Path $repoRoot "crates\ccsm-platform\vendor\portable-pty\LICENSE.md") -Destination (Join-Path $noticeRoot "portable-pty-LICENSE.md")
Copy-Item -LiteralPath (Join-Path $repoRoot "crates\ccsm-platform\vendor\HERDR-APACHE-2.0.txt") -Destination $noticeRoot
Copy-Item -LiteralPath (Join-Path $repoRoot "crates\ccsm-platform\vendor\NOTICE.md") -Destination (Join-Path $noticeRoot "VENDORED-COMPONENTS.md")
Copy-Item -LiteralPath (Join-Path $repoRoot "README.md") -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination $stageRoot

Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal
$archive = Get-Item -LiteralPath $zipPath
$stream = [System.IO.File]::OpenRead($zipPath)
try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}
finally {
    $stream.Dispose()
}
[pscustomobject]@{
    Archive = $archive.FullName
    Bytes = $archive.Length
    SHA256 = $hash
}
