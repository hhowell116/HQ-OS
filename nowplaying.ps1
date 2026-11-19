Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $m = $asTask.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$coverDir = Join-Path $env:TEMP 'hq-cover'; New-Item -ItemType Directory -Force $coverDir | Out-Null; $coverCache = @{}; $coverMiss = @{}
# Saves the track's album art to %TEMP%hq-cover<hash>.img once per track; returns the path ('' if none)
function Get-Cover($p, $key) {
  if ($coverCache.ContainsKey($key)) { return $coverCache[$key] }
  $path = ""; $err = ""
  try {
    if ($p.Thumbnail) {
      $st = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
      $mi = [System.IO.WindowsRuntimeStreamExtensions].GetMethod("AsStreamForRead", [Type[]]@([Windows.Storage.Streams.IInputStream]))
      $in = $mi.Invoke($null, @(,$st)); $ms = New-Object IO.MemoryStream; $in.CopyTo($ms); $in.Dispose()
      if ($ms.Length -gt 0 -and $ms.Length -lt 8000000) { $h = [BitConverter]::ToString([Security.Cryptography.MD5]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($key))).Replace("-",""); $path = Join-Path $coverDir ($h + ".img"); [IO.File]::WriteAllBytes($path, $ms.ToArray()) } else { $err = "empty thumbnail" }
    } else { $err = "no thumbnail" }
  } catch { $path = ""; $err = ($_.Exception.Message -replace '[
"]', ' ') }
  $r = [pscustomobject]@{ path = $path; err = $err }
  if ($path -or $err -ne "no thumbnail") { $coverCache[$key] = $r } else { $coverMiss[$key] = 1 + [int]$coverMiss[$key]; if ($coverMiss[$key] -ge 4) { $coverCache[$key] = $r } }  # thumbnails can load late: retry a few polls
  return $r
}
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
# Prints one JSON line every 3 s while HQ's globe is visible (HQ kills this process when it is hidden). Reads Windows' media session only: title, artist, app, play state.
while ($true) {
  try {
    $out = @()
    foreach ($s in $mgr.GetSessions()) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $c = Get-Cover $p ($s.SourceAppUserModelId + '|' + $p.Artist + '|' + $p.Title + '|' + $p.AlbumTitle); $out += [pscustomobject]@{ app = $s.SourceAppUserModelId; title = $p.Title; artist = $p.Artist; status = $s.GetPlaybackInfo().PlaybackStatus.ToString(); cover = $c.path; coverErr = $c.err }
    }
    $cur = $mgr.GetCurrentSession(); $curId = if ($cur) { $cur.SourceAppUserModelId } else { "" }
    [Console]::Out.WriteLine(([pscustomobject]@{ current = $curId; sessions = @($out) } | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush()
  } catch { [Console]::Out.WriteLine('{"error":"' + ($_.Exception.Message -replace '"', "'") + '"}') }
  Start-Sleep -Seconds 2
}
