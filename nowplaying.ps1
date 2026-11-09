Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $m = $asTask.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
# Prints one JSON line every 3 s while HQ's globe is visible (HQ kills this process when it is hidden). Reads Windows' media session only: title, artist, app, play state.
while ($true) {
  try {
    $out = @()
    foreach ($s in $mgr.GetSessions()) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $out += [pscustomobject]@{ app = $s.SourceAppUserModelId; title = $p.Title; artist = $p.Artist; status = $s.GetPlaybackInfo().PlaybackStatus.ToString() }
    }
    $cur = $mgr.GetCurrentSession(); $curId = if ($cur) { $cur.SourceAppUserModelId } else { "" }
    [Console]::Out.WriteLine(([pscustomobject]@{ current = $curId; sessions = @($out) } | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush()
  } catch { [Console]::Out.WriteLine('{"error":"' + ($_.Exception.Message -replace '"', "'") + '"}') }
  Start-Sleep -Seconds 3
}
