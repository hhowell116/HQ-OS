# Add a Pinterest pin to the HQ OS media library: pwsh -NoProfile -File add-pin.ps1 <pin url> "<Name>"
# Takes the pin's main image (og:image) hash and tries the original GIF (GIF89a verified); else the pin's 720p mp4; else reports a still image.
param([Parameter(Mandatory)][string]$Url, [Parameter(Mandatory)][string]$Name)
$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot; $ua = @{ 'User-Agent' = 'Mozilla/5.0' }
$html = (Invoke-WebRequest -Uri $Url -Headers $ua -UseBasicParsing).Content
$slug = ($Name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-'); $file = $null
$img = $null
foreach ($m in [regex]::Matches($html, '<meta\b[^>]*>')) {
  if ($m.Value -match 'property="og:image"' -and $m.Value -match 'content="([^"]+)"') { $img = $Matches[1]; break }
}
if (-not $img -and $html -match '<link[^>]*rel="preload"[^>]*as="image"[^>]*href="([^"]+)"') { $img = $Matches[1] }
if ($img -match '/([0-9a-f]{2})/([0-9a-f]{2})/([0-9a-f]{2})/([0-9a-f]+)\.\w+$') {
  $g = "https://i.pinimg.com/originals/$($Matches[1])/$($Matches[2])/$($Matches[3])/$($Matches[4]).gif"
  $out = Join-Path $dir "$slug.gif"
  try {
    Invoke-WebRequest -Uri $g -Headers $ua -OutFile $out -UseBasicParsing
    $hdr = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($out)[0..5])
    if ($hdr -like 'GIF8*') { $file = "$slug.gif" } else { Remove-Item $out }
  } catch { Remove-Item $out -ErrorAction SilentlyContinue }
}
if (-not $file -and $html -match 'https://v1\.pinimg\.com/videos/mc/720p/[^"\\s]+\.mp4') {
  $out = Join-Path $dir "$slug.mp4"
  Invoke-WebRequest -Uri $Matches[0] -Headers $ua -OutFile $out -UseBasicParsing; $file = "$slug.mp4"
}
if (-not $file) { Write-Host 'still image, nothing to animate'; exit 1 }
$ip = Join-Path $dir 'index.json'; $idx = if (Test-Path $ip) { Get-Content $ip -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
$idx[$file] = $Name; $idx | ConvertTo-Json | Set-Content $ip -Encoding utf8
Write-Host "Added $file as '$Name'. The next swap picks it up."
