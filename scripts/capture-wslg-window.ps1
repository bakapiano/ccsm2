param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [string]$DistroName = "Ubuntu-24.04"
)

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CcsmWslgCaptureNative
{
    public delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);
}
'@

$candidates = [System.Collections.Generic.List[object]]::new()
$callback = [CcsmWslgCaptureNative+EnumWindowsProc] {
    param([IntPtr]$window, [IntPtr]$parameter)

    if (-not [CcsmWslgCaptureNative]::IsWindowVisible($window)) {
        return $true
    }
    $length = [CcsmWslgCaptureNative]::GetWindowTextLength($window)
    if ($length -le 0) {
        return $true
    }
    $text = [Text.StringBuilder]::new($length + 1)
    [void][CcsmWslgCaptureNative]::GetWindowText($window, $text, $text.Capacity)
    $title = $text.ToString()
    if ($title -notmatch "CCSM" -or $title -notmatch [regex]::Escape($DistroName)) {
        return $true
    }

    [uint32]$windowProcessId = 0
    [void][CcsmWslgCaptureNative]::GetWindowThreadProcessId(
        $window,
        [ref]$windowProcessId
    )
    $processName = (Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue).ProcessName
    if ($processName -ne "msrdc") {
        return $true
    }

    $rect = [CcsmWslgCaptureNative+Rect]::new()
    [void][CcsmWslgCaptureNative]::GetWindowRect($window, [ref]$rect)
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -gt 0 -and $height -gt 0) {
        $candidates.Add([pscustomobject]@{
            Window = $window
            Rect = $rect
            Area = $width * $height
        })
    }
    return $true
}
[void][CcsmWslgCaptureNative]::EnumWindows($callback, [IntPtr]::Zero)

$target = $candidates | Sort-Object Area -Descending | Select-Object -First 1
if (-not $target) {
    throw "No visible CCSM WSLg window was found for $DistroName"
}

[void][CcsmWslgCaptureNative]::ShowWindow($target.Window, 9)
[void][CcsmWslgCaptureNative]::SetForegroundWindow($target.Window)
Start-Sleep -Milliseconds 250

$rect = [CcsmWslgCaptureNative+Rect]::new()
[void][CcsmWslgCaptureNative]::GetWindowRect($target.Window, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$parent = Split-Path -Parent $OutputPath
if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
}

$bitmap = [Drawing.Bitmap]::new($width, $height)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen(
        $rect.Left,
        $rect.Top,
        0,
        0,
        [Drawing.Size]::new($width, $height)
    )
    $bitmap.Save($OutputPath, [Drawing.Imaging.ImageFormat]::Png)
}
finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}

Write-Output $OutputPath
