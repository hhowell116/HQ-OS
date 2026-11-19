# Media keys for HQ's music box: nowcontrol.ps1 next|prev|toggle  (acts on the session Windows calls current)
param([Parameter(Mandatory)][ValidateSet('next','prev','toggle')][string]$Cmd)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $m = $asTask.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s = $mgr.GetCurrentSession(); if (-not $s) { $s = $mgr.GetSessions() | Select-Object -First 1 }
if (-not $s) { exit 1 }
switch ($Cmd) { 'next' { [void](Await ($s.TrySkipNextAsync()) ([bool])) } 'prev' { [void](Await ($s.TrySkipPreviousAsync()) ([bool])) } 'toggle' { [void](Await ($s.TryTogglePlayPauseAsync()) ([bool])) } }
