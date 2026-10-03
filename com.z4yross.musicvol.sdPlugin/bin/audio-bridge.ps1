# Long-lived helper: reads one command per line on stdin, answers one JSON line on stdout.
# Talks to WASAPI (CoreAudio) through COM interop so the plugin can read/set per-app volume
# without shipping a native module. Walks every active render device, not just the default,
# because a Voicemeeter setup routes players to virtual outputs.
#
# Protocol (stdin -> stdout):
#   status <exe1,exe2,...>            -> best candidate for the priority list, with now-playing
#                                        metadata from SMTC (Windows.Media.Control) when the app
#                                        publishes it (Spotify and Electron players do)
#   set    <exe> <volume 0..1>        -> apply to every session of that exe, then status
#   mute   <exe> <0|1|toggle>         -> same
#   art    <exe>                      -> {"key","mime","data"} 72px PNG album art (base64) for the current
#                                        track, or {"key":null}; status carries the same key so the
#                                        caller only asks when it changes
#   ctl    <exe> <playpause|play|pause|next|prev>
#                                     -> transport command on that app's SMTC session, then status;
#                                        {"error"} when the app has no session or refused it
#   list                              -> every session with a live process
#   ping                              -> {"ok":true}

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace MusicVol
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorCom { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceCollection
    {
        int GetCount(out int count);
        int Item(int index, out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IntPtr props);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionManager2
    {
        int GetAudioSessionControl(ref Guid sessionGuid, int streamFlags, out IAudioSessionControl2 control);
        int GetSimpleAudioVolume(ref Guid sessionGuid, int streamFlags, out ISimpleAudioVolume volume);
        int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
        int RegisterSessionNotification(IntPtr notification);
        int UnregisterSessionNotification(IntPtr notification);
        int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr notification);
        int UnregisterDuckNotification(IntPtr notification);
    }

    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionEnumerator
    {
        int GetCount(out int count);
        int GetSession(int index, out IAudioSessionControl2 session);
    }

    // IAudioSessionControl2 : IAudioSessionControl. COM interop does not inherit vtable slots
    // across IUnknown-style interfaces, so the base methods are redeclared in order.
    [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionControl2
    {
        int GetState(out int state);
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
        int GetGroupingParam(out Guid grouping);
        int SetGroupingParam(ref Guid grouping, ref Guid context);
        int RegisterAudioSessionNotification(IntPtr notification);
        int UnregisterAudioSessionNotification(IntPtr notification);
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetProcessId(out uint pid);
        int IsSystemSoundsSession();
        int SetDuckingPreference(bool optOut);
    }

    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISimpleAudioVolume
    {
        int SetMasterVolume(float level, ref Guid context);
        int GetMasterVolume(out float level);
        int SetMute(bool mute, ref Guid context);
        int GetMute(out bool mute);
    }

    [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioMeterInformation
    {
        int GetPeakValue(out float peak);
        int GetMeteringChannelCount(out int count);
        int GetChannelsPeakValues(int count, IntPtr values);
        int QueryHardwareSupport(out int mask);
    }

    public class Session
    {
        public uint Pid;
        public int State;          // 0 inactive, 1 active, 2 expired
        public float Volume;
        public bool Mute;
        public float Peak;
        public ISimpleAudioVolume Vol;
    }

    public static class Audio
    {
        const int eRender = 0;
        const int DEVICE_STATE_ACTIVE = 1;
        const int CLSCTX_ALL = 23;
        static Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

        public static System.Collections.Generic.List<Session> Sessions()
        {
            var result = new System.Collections.Generic.List<Session>();
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            IMMDeviceCollection devices;
            enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out devices);
            int deviceCount;
            devices.GetCount(out deviceCount);

            for (int d = 0; d < deviceCount; d++)
            {
                IMMDevice device;
                devices.Item(d, out device);
                object managerObj;
                if (device.Activate(ref IID_IAudioSessionManager2, CLSCTX_ALL, IntPtr.Zero, out managerObj) != 0) continue;
                var manager = (IAudioSessionManager2)managerObj;
                IAudioSessionEnumerator sessions;
                if (manager.GetSessionEnumerator(out sessions) != 0) continue;
                int sessionCount;
                sessions.GetCount(out sessionCount);

                for (int s = 0; s < sessionCount; s++)
                {
                    IAudioSessionControl2 control;
                    if (sessions.GetSession(s, out control) != 0) continue;
                    uint pid;
                    control.GetProcessId(out pid);
                    if (pid == 0) continue;
                    var session = new Session();
                    session.Pid = pid;
                    control.GetState(out session.State);
                    session.Vol = (ISimpleAudioVolume)control;
                    session.Vol.GetMasterVolume(out session.Volume);
                    session.Vol.GetMute(out session.Mute);
                    try { ((IAudioMeterInformation)control).GetPeakValue(out session.Peak); } catch { session.Peak = 0; }
                    result.Add(session);
                }
            }
            return result;
        }

        public static void SetVolume(Session session, float level)
        {
            Guid ctx = Guid.Empty;
            session.Vol.SetMasterVolume(Math.Max(0f, Math.Min(1f, level)), ref ctx);
        }

        public static void SetMute(Session session, bool mute)
        {
            Guid ctx = Guid.Empty;
            session.Vol.SetMute(mute, ref ctx);
        }
    }
}
"@

# --- SMTC (what the Windows volume flyout shows: title, artist, playback state, art) ---------
# PowerShell 5.1 cannot project the WinRT stream types needed for the thumbnail, so this part
# lives in a small C# DLL next to this script (smtc/Smtc.cs, built by smtc/build.cmd).
$smtcReady = $false
try {
    # Load a shadow copy: Add-Type locks the file, which would block rebuilding the DLL
    # while the plugin runs. The copy is keyed by content hash so a rebuild is picked up.
    $dll = Join-Path $PSScriptRoot 'smtc\Smtc.dll'
    $hash = (Get-FileHash $dll -Algorithm SHA1).Hash.Substring(0, 12)
    $shadow = Join-Path $env:TEMP "musicvol-smtc-$hash.dll"
    if (-not (Test-Path $shadow)) { Copy-Item $dll $shadow }
    Add-Type -Path $shadow
    $smtcReady = $true
} catch {
    [Console]::Error.WriteLine("SMTC unavailable: $($_.Exception.Message)")
}

# Now-playing for one exe, or $null.
function Get-Track([string] $exe) {
    if (-not $script:smtcReady) { return $null }
    try {
        $now = Measure-Stage "smtc.now($exe)" { [MusicVol.Smtc]::Now($exe, $false) }
        if (-not $now) { return $null }
        return @{
            title    = [string] $now['title']
            artist   = [string] $now['artist']
            album    = [string] $now['album']
            playback = [string] $now['playback']
            artKey   = $now['artKey']
        }
    } catch {
        [Console]::Error.WriteLine("SMTC read failed: $($_.Exception.Message)")
        return $null
    }
}

# Album art as a 72px PNG in base64. One entry cached: the plugin only asks when the key changes.
$artCache = @{ key = $null; payload = $null }

function Get-Art([string] $exe) {
    if (-not $script:smtcReady) { return @{ key = $null } }
    $now = [MusicVol.Smtc]::Now($exe, $false)
    if (-not $now -or -not $now['artKey']) { return @{ key = $null } }
    if ($script:artCache.key -eq $now['artKey']) { return $script:artCache.payload }

    $withArt = [MusicVol.Smtc]::Now($exe, $true)
    if (-not $withArt -or -not $withArt['data']) { return @{ key = $null } }
    $payload = @{ key = [string] $withArt['artKey']; mime = [string] $withArt['mime']; data = [string] $withArt['data'] }
    $script:artCache = @{ key = $payload.key; payload = $payload }
    return $payload
}

# pid -> exe name, rebuilt once per snapshot. A single Get-Process is ~60ms; Get-Process -Id
# per pid is ~300ms each (Windows walks the whole process table on every lookup), which with
# a dozen audio sessions blew past the plugin's 4s request timeout.
$processNames = @{}

function Get-ExeName([uint32] $processId) {
    return $processNames[$processId]
}

# One snapshot of every session, tagged with its exe name (compared case-insensitively later).
function Get-Snapshot {
    $script:processNames = @{}
    foreach ($p in (Measure-Stage 'get-process' { Get-Process })) { $script:processNames[[uint32] $p.Id] = $p.ProcessName }
    $tagged = @()
    foreach ($s in (Measure-Stage 'wasapi.sessions' { [MusicVol.Audio]::Sessions() })) {
        $exe = Get-ExeName $s.Pid
        if (-not $exe) { continue }
        $tagged += [pscustomobject]@{ Exe = $exe; Session = $s }
    }
    return $tagged
}

function Test-Playing($session) {
    return ($session.State -eq 1 -and $session.Peak -gt 0.001)
}

# Last app that was heard playing. When everything is paused the dial stays on it instead
# of snapping back to the top of the priority list.
$lastPlaying = $null

function Select-Candidate($snapshot, [string[]] $priority) {
    # Whoever is making noise wins; ties go to priority order. With nothing playing, stick to
    # the last one that did (if still open), else the first open one by priority.
    $playing = $null
    $first = $null
    $open = @()
    foreach ($exe in $priority) {
        $mine = @($snapshot | Where-Object { $_.Exe -ieq $exe })
        if ($mine.Count -eq 0) { continue }
        $open += $exe
        if (-not $first) { $first = $exe }
        $isPlaying = @($mine | Where-Object { Test-Playing $_.Session }).Count -gt 0
        if (-not $isPlaying) { $t = Get-Track $exe; $isPlaying = ($t -and $t.playback -eq 'playing') }
        if ($isPlaying -and -not $playing) { $playing = $exe }
    }
    if ($playing) { $script:lastPlaying = $playing; return $playing }
    if ($script:lastPlaying -and ($open -icontains $script:lastPlaying)) { return $script:lastPlaying }
    return $first
}

function Get-Status($snapshot, [string[]] $priority) {
    $exe = Select-Candidate $snapshot $priority
    if (-not $exe) { return @{ found = $false } }
    $mine = @($snapshot | Where-Object { $_.Exe -ieq $exe })
    # Report the active session when there is one; idle sessions can carry a stale volume.
    $rep = ($mine | Sort-Object { $_.Session.State -eq 1 } -Descending | Select-Object -First 1).Session
    $track = Get-Track $exe
    $playing = (Test-Playing $rep) -or ($track -and $track.playback -eq 'playing')
    return @{
        found    = $true
        exe      = $exe
        volume   = [math]::Round($rep.Volume, 4)
        mute     = [bool] $rep.Mute
        playing  = $playing
        sessions = $mine.Count
        track    = $track
    }
}

# Stage timings to stderr, enabled by MUSICVOL_PROFILE=1 (never set under Stream Deck).
$profile = $env:MUSICVOL_PROFILE -eq '1'
function Measure-Stage([string] $name, [scriptblock] $block) {
    if (-not $script:profile) { return & $block }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try { return & $block } finally { [Console]::Error.WriteLine("prof $name $($sw.ElapsedMilliseconds)ms") }
}

function Write-Json($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 3))
    [Console]::Out.Flush()
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }
    $parts = $line -split '\s+'
    $cmd = $parts[0].ToLowerInvariant()
    try {
        switch ($cmd) {
            'ping' { Write-Json @{ ok = $true } }
            'status' {
                $priority = @(($parts[1] -split ',') | Where-Object { $_ })
                Write-Json (Get-Status (Get-Snapshot) $priority)
            }
            'set' {
                $exe = $parts[1]
                $level = [float]::Parse($parts[2], [System.Globalization.CultureInfo]::InvariantCulture)
                $snapshot = Get-Snapshot
                foreach ($t in @($snapshot | Where-Object { $_.Exe -ieq $exe })) { [MusicVol.Audio]::SetVolume($t.Session, $level) }
                Write-Json (Get-Status (Get-Snapshot) @($exe))
            }
            'mute' {
                $exe = $parts[1]
                $mode = $parts[2]
                $snapshot = Get-Snapshot
                $mine = @($snapshot | Where-Object { $_.Exe -ieq $exe })
                if ($mine.Count -gt 0) {
                    $target = switch ($mode) { '1' { $true } '0' { $false } default { -not $mine[0].Session.Mute } }
                    foreach ($t in $mine) { [MusicVol.Audio]::SetMute($t.Session, $target) }
                }
                Write-Json (Get-Status (Get-Snapshot) @($exe))
            }
            'art' {
                Write-Json (Get-Art $parts[1])
            }
            'ctl' {
                $exe = $parts[1]
                $command = $parts[2].ToLowerInvariant()
                if (-not $script:smtcReady) { throw 'SMTC unavailable' }
                if (-not [MusicVol.Smtc]::Control($exe, $command)) { throw "$exe rejected $command" }
                # Players update their playback state asynchronously; give SMTC a beat so the
                # status we answer with already shows the new play/pause state.
                Start-Sleep -Milliseconds 150
                Write-Json (Get-Status (Get-Snapshot) @($exe))
            }
            'list' {
                $rows = @(Get-Snapshot | ForEach-Object {
                    @{ exe = $_.Exe; pid = $_.Session.Pid; state = $_.Session.State; volume = $_.Session.Volume; mute = $_.Session.Mute; peak = $_.Session.Peak }
                })
                Write-Json $rows
            }
            default { Write-Json @{ error = "unknown command: $cmd" } }
        }
    } catch {
        Write-Json @{ error = $_.Exception.Message }
    }
}
