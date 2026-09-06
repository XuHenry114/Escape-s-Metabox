Add-Type -AssemblyName System.Drawing
$outDir = "D:\workplace\metabox-game\crops"
# 26-50 号盒全部特殊格复核: 图片名, 卡号, 行(1..7), 列(1..7)
$defs = @(
  @{img='j7ymjdag'; n=3;  r=1; c=3}, @{img='j7ymjdag'; n=16; r=3; c=2}, @{img='j7ymjdag'; n=26; r=4; c=5}, @{img='j7ymjdag'; n=41; r=6; c=6},
  @{img='w7p7vuhe'; n=13; r=2; c=6}, @{img='w7p7vuhe'; n=37; r=6; c=2},
  @{img='uxgmt8hu'; n=10; r=2; c=3}, @{img='uxgmt8hu'; n=11; r=2; c=4},
  @{img='bzf3tlnt'; n=9;  r=2; c=2}, @{img='bzf3tlnt'; n=16; r=3; c=2}, @{img='bzf3tlnt'; n=17; r=3; c=3}, @{img='bzf3tlnt'; n=18; r=3; c=4}, @{img='bzf3tlnt'; n=37; r=6; c=2}, @{img='bzf3tlnt'; n=39; r=6; c=4}, @{img='bzf3tlnt'; n=41; r=6; c=6},
  @{img='on8s4cno'; n=18; r=3; c=4},
  @{img='todd02ma'; n=26; r=4; c=5},
  @{img='j0dktmhi'; n=12; r=2; c=5}, @{img='j0dktmhi'; n=20; r=3; c=6}, @{img='j0dktmhi'; n=24; r=4; c=3}, @{img='j0dktmhi'; n=31; r=5; c=4}, @{img='j0dktmhi'; n=40; r=6; c=5},
  @{img='u84fewxt'; n=26; r=4; c=5},
  @{img='xffvlw6a'; n=9;  r=2; c=2}, @{img='xffvlw6a'; n=14; r=2; c=7}, @{img='xffvlw6a'; n=33; r=5; c=5}, @{img='xffvlw6a'; n=41; r=6; c=6},
  @{img='mpuqf6ak'; n=13; r=2; c=6}, @{img='mpuqf6ak'; n=19; r=3; c=5}, @{img='mpuqf6ak'; n=31; r=5; c=4},
  @{img='llbsiwo1'; n=13; r=2; c=6}, @{img='llbsiwo1'; n=27; r=4; c=6},
  @{img='kzh1c2k7'; n=25; r=4; c=4},
  @{img='tj5lhf1r'; n=25; r=4; c=4},
  @{img='b5ahoye7'; n=19; r=3; c=5}, @{img='b5ahoye7'; n=32; r=5; c=4}, @{img='b5ahoye7'; n=41; r=6; c=6},
  @{img='1ph4ncno'; n=13; r=2; c=6}, @{img='1ph4ncno'; n=15; r=3; c=1}, @{img='1ph4ncno'; n=17; r=3; c=3},
  @{img='uj5x0wfg'; n=13; r=2; c=6}, @{img='uj5x0wfg'; n=17; r=3; c=3}, @{img='uj5x0wfg'; n=35; r=5; c=7}, @{img='uj5x0wfg'; n=41; r=6; c=6}, @{img='uj5x0wfg'; n=42; r=6; c=7}, @{img='uj5x0wfg'; n=48; r=7; c=6},
  @{img='7w70u1ky'; n=32; r=5; c=4}
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
  $out = Join-Path $outDir "rc_$($d.img)_$($d.n).png"
  $scaled.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $scaled.Dispose()
}
Write-Output "done $($defs.Count) crops"
