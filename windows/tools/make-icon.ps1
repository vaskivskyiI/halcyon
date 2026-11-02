# Draws the Halcyon icon (web/public/icon.svg without the yellow dot: gradient rounded square, white envelope) and
# writes windows/Halcyon/halcyon.ico with PNG entries at 16-256 px. Run: powershell -File windows/tools/make-icon.ps1
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$out = Join-Path $PSScriptRoot '..\Halcyon\halcyon.ico'

function Draw([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'; $g.Clear([System.Drawing.Color]::Transparent)
  $s = $size / 64.0
  $g.ScaleTransform($s, $s)
  # Rounded square (rx 14), diagonal gradient #38bdf8 -> #2563eb.
  $r = 14; $sq = New-Object System.Drawing.Drawing2D.GraphicsPath
  $sq.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90); $sq.AddArc(64 - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
  $sq.AddArc(64 - 2 * $r, 64 - 2 * $r, 2 * $r, 2 * $r, 0, 90); $sq.AddArc(0, 64 - 2 * $r, 2 * $r, 2 * $r, 90, 90); $sq.CloseFigure()
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new(0, 0)), ([System.Drawing.PointF]::new(64, 64)),
    ([System.Drawing.Color]::FromArgb(0x38, 0xbd, 0xf8)), ([System.Drawing.Color]::FromArgb(0x25, 0x63, 0xeb))
  $g.FillPath($grad, $sq)
  # Envelope body: M12 22 l20 14 20-14 v20 a4 4 0 0 1-4 4 H16 a4 4 0 0 1-4-4z (opacity .95)
  $body = New-Object System.Drawing.Drawing2D.GraphicsPath
  $body.AddLine(12, 22, 32, 36); $body.AddLine(32, 36, 52, 22); $body.AddLine(52, 22, 52, 42)
  $body.AddArc(44, 38, 8, 8, 0, 90); $body.AddLine(48, 46, 16, 46); $body.AddArc(12, 38, 8, 8, 90, 90); $body.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(242, 255, 255, 255))), $body)
  # Flap: M12 20 a4 4 0 0 1 4-4 h32 a4 4 0 0 1 4 4 L32 34z (opacity .7)
  $flap = New-Object System.Drawing.Drawing2D.GraphicsPath
  $flap.AddArc(12, 16, 8, 8, 180, 90); $flap.AddLine(16, 16, 48, 16); $flap.AddArc(44, 16, 8, 8, 270, 90); $flap.AddLine(52, 20, 32, 34); $flap.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(178, 255, 255, 255))), $flap)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  return , $ms.ToArray()
}

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$pngs = $sizes | ForEach-Object { , (Draw $_) }
$f = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $f
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $n = $sizes[$i] % 256
  $w.Write([byte]$n); $w.Write([byte]$n); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$pngs[$i].Length); $w.Write([UInt32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
[System.IO.File]::WriteAllBytes([System.IO.Path]::GetFullPath($out), $f.ToArray())
Write-Output "Wrote $out"
