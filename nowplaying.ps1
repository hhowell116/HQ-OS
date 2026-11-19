Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $m = $asTask.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$coverDir = Join-Path $env:TEMP 'hq-cover'; New-Item -ItemType Directory -Force $coverDir | Out-Null; $coverCache = @{}
# Saves the track's album art to %TEMP%hq-cover<hash>.img once per track; returns the path ('' if none)
function Get-Cover($p, $key) {
  if ($coverCache.ContainsKey($key)) { return $coverCache[$key] }
  $path = ''
  try { if ($p.Thumbnail) { $st = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType]); $n = [int]$st.Size; if ($n -gt 0 -and $n -lt 8000000) { $rd = [Windows.Storage.Streams.DataReader]::new($st.GetInputStreamAt(0)); [void](Await ($rd.LoadAsync([uint32]$n)) ([uint32])); $b = New-Object byte[] $n; $rd.ReadBytes($b); $h = [BitConverter]::ToString([Security.Cryptography.MD5]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($key))).Replace('-',''); $path = Join-Path $coverDir ($h + '.img'); [IO.File]::WriteAllBytes($path, $b) } } } catch { $path = '' }
  $coverCache[$key] = $path; return $path
}
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
# Prints one JSON line every 3 s while HQ's globe is visible (HQ kills this process when it is hidden). Reads Windows' media session only: title, artist, app, play state.
while ($true) {
  try {
    $out = @()
    foreach ($s in $mgr.GetSessions()) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $out += [pscustomobject]@{ app = $s.SourceAppUserModelId; title = $p.Title; artist = $p.Artist; status = $s.GetPlaybackInfo().PlaybackStatus.ToString(); cover = (Get-Cover $p ($s.SourceAppUserModelId + '|' + $p.Artist + '|' + $p.Title + '|' + $p.AlbumTitle)) }
    }
    $cur = $mgr.GetCurrentSession(); $curId = if ($cur) { $cur.SourceAppUserModelId } else { "" }
    [Console]::Out.WriteLine(([pscustomobject]@{ current = $curId; sessions = @($out) } | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush()
  } catch { [Console]::Out.WriteLine('{"error":"' + ($_.Exception.Message -replace '"', "'") + '"}') }
  Start-Sleep -Seconds 2
}
