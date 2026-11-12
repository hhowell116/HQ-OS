# Add a Pinterest pin to the HQ OS media library: pwsh -NoProfile -File add-pin.ps1 <pin url> "<Name>"
# Downloads the original GIF (verifies the GIF89a header); if the pin is a video, falls back to the V_720P mp4.
param([Parameter(Mandatory)][string]$Url, [Parameter(Mandatory)][string]$Name)
$dir = $PSScriptRoot; $ua = @{ 'User-Agent' = 'Mozilla/5.0' }
$html = (Invoke-WebRequest -Uri $Url -Headers $ua -UseBasicParsing).Content
$slug = ($Name.ToLower() -replace '[^a-z0-9]+', '-').Trim('-'); $file = $null
if ($html -match 'https://i\.pinimg\.com/[^"\s\]*?/([0-9a-f]{2})/([0-9a-f]{2})/([0-9a-f]{2})/([0-9a-f]+)\.(jpg|gif|png)') {
  $g = "https://i.pinimg.com/originals/$($Matches[1])/$($Matches[2])/$($Matches[3])/$($Matches[4]).gif"
  $out = Join-Path $dir "$slug.gif"
  try { Invoke-WebRequest -Uri $g -Headers $ua -OutFile $out -UseBasicParsing
    if ([Text.Encoding]::ASCII.GetString((Get-Content $out -AsByteStream -TotalCount 6)) -like 'GIF8*') { $file = "$slug.gif" } else { Remove-Item $out } } catch { Remove-Item $out -ErrorAction SilentlyContinue }
}
if (-not $file -and $html -match '"V_720P"\s*:\s*\{[^}]*?"url"\s*:\s*"([^"]+)"') {
  $v = $Matches[1] -replace '\u002F', '/' -replace '\/', '/'; $out = Join-Path $dir "$slug.mp4"
  Invoke-WebRequest -Uri $v -Headers $ua -OutFile $out -UseBasicParsing; $file = "$slug.mp4"
}
if (-not $file) { Write-Error 'No GIF or video found for that pin.'; exit 1 }
$ip = Join-Path $dir 'index.json'; $idx = if (Test-Path $ip) { Get-Content $ip -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
$idx[$file] = $Name; $idx | ConvertTo-Json | Set-Content $ip -Encoding utf8
Write-Host "Added $file as '$Name'. Reload not needed: the next swap picks it up."
