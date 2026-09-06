Add-Type -AssemblyName System.Drawing
$outDir = "D:\workplace\metabox-game\crops"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 需要复核的卡片: 图片名, 卡号, 行(1..7), 列(1..7)
$defs = @(
  @{img='8m7vp051'; n=17; r=3; c=3},
  @{img='8m7vp051'; n=24; r=4; c=3},
  @{img='8m7vp051'; n=32; r=5; c=4},
  @{img='8m7vp051'; n=35; r=5; c=7},
  @{img='kx8czy8l'; n=11; r=2; c=4},
  @{img='esibzfaw'; n=13; r=2; c=6},
  @{img='esibzfaw'; n=41; r=6; c=6},
  @{img='d4zjcnd8'; n=25; r=4; c=4},
  @{img='1i80oje1'; n=10; r=2; c=3},
  @{img='1i80oje1'; n=12; r=2; c=5},
  @{img='1i80oje1'; n=38; r=6; c=3},
  @{img='ss9mpkf6'; n=13; r=2; c=6},
  @{img='ss9mpkf6'; n=20; r=3; c=6},
  @{img='ss9mpkf6'; n=27; r=4; c=6},
  @{img='ss9mpkf6'; n=34; r=5; c=6},
  @{img='516u0yuc'; n=16; r=3; c=2},
  @{img='516u0yuc'; n=21; r=3; c=7},
  @{img='516u0yuc'; n=23; r=4; c=2},
  @{img='516u0yuc'; n=27; r=4; c=6},
  @{img='516u0yuc'; n=34; r=5; c=6},
  @{img='yasaeg2c'; n=31; r=5; c=3},
  @{img='j7ymjdag'; n=3; r=1; c=3},
  @{img='j7ymjdag'; n=16; r=3; c=2},
  @{img='j7ymjdag'; n=26; r=4; c=5},
  @{img='j7ymjdag'; n=41; r=6; c=6},
  @{img='w7p7vuhe'; n=13; r=2; c=6},
  @{img='w7p7vuhe'; n=37; r=6; c=2}
)
foreach ($d in $defs) {
  $src = "D:\workplace\maps_png\$($d.img).png"
  $bmp = [System.Drawing.Bitmap]::FromFile($src)
  $w = $bmp.Width / 7.0
  $h = $bmp.Height / 7.0
  $x = [int](($d.c - 1) * $w) + 1
  $y = [int](($d.r - 1) * $h) + 1
  $cw = [int]$w - 2
  $ch = [int]$h - 2
  $rect = New-Object System.Drawing.Rectangle($x, $y, $cw, $ch)
  $crop = $bmp.Clone($rect, $bmp.PixelFormat)
  $scaled = New-Object System.Drawing.Bitmap ($crop.Width * 3), ($crop.Height * 3)
  $g = [System.Drawing.Graphics]::FromImage($scaled)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($crop, 0, 0, $scaled.Width, $scaled.Height)
  $g.Dispose(); $crop.Dispose(); $bmp.Dispose()
  $out = Join-Path $outDir "$($d.img)_$($d.n).png"
  $scaled.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $scaled.Dispose()
  Write-Output "saved $out"
}
