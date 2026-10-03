// Now-playing reader over SMTC (Windows.Media.Control), the same source the Windows volume
// flyout uses. Lives in C# because PowerShell 5.1 cannot project the WinRT stream types it
// needs to read the thumbnail; built with csc.exe (see build.cmd next to it) and shipped as Smtc.dll.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace MusicVol
{
    public static class Smtc
    {
        static GlobalSystemMediaTransportControlsSessionManager manager;

        static GlobalSystemMediaTransportControlsSessionManager Manager()
        {
            if (manager == null)
                manager = GlobalSystemMediaTransportControlsSessionManager.RequestAsync().AsTask().Result;
            return manager;
        }

        // Touch-strip pixmaps are ~56px; shipping Spotify's 300px art over the socket every
        // track change is waste, so it is squared and downscaled here.
        const int ArtSize = 72;

        static string ScaleToPngBase64(byte[] original)
        {
            using (var input = new MemoryStream(original))
            using (var source = Image.FromStream(input))
            using (var target = new Bitmap(ArtSize, ArtSize))
            using (var g = Graphics.FromImage(target))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = SmoothingMode.HighQuality;
                // Center-crop to a square, then scale.
                var side = Math.Min(source.Width, source.Height);
                var crop = new Rectangle((source.Width - side) / 2, (source.Height - side) / 2, side, side);
                g.DrawImage(source, new Rectangle(0, 0, ArtSize, ArtSize), crop, GraphicsUnit.Pixel);
                using (var output = new MemoryStream())
                {
                    target.Save(output, ImageFormat.Png);
                    return Convert.ToBase64String(output.ToArray());
                }
            }
        }

        // SMTC identifies sessions by AUMID ("SpotifyAB.SpotifyMusic_...!Spotify", "Deezer.exe"),
        // so match by substring. Returns null when the app has no session.
        static GlobalSystemMediaTransportControlsSession Find(string exe)
        {
            foreach (var session in Manager().GetSessions())
            {
                var id = session.SourceAppUserModelId ?? "";
                if (id.IndexOf(exe, StringComparison.OrdinalIgnoreCase) >= 0) return session;
            }
            return null;
        }

        // Transport control aimed at one app's session, so the dial drives the player it is
        // following rather than whichever app Windows considers current. Returns false when
        // the app has no session or rejected the command (e.g. no next track).
        public static bool Control(string exe, string command)
        {
            var session = Find(exe);
            if (session == null) return false;
            try
            {
                switch (command)
                {
                    case "playpause": return session.TryTogglePlayPauseAsync().AsTask().Result;
                    case "play": return session.TryPlayAsync().AsTask().Result;
                    case "pause": return session.TryPauseAsync().AsTask().Result;
                    case "next": return session.TrySkipNextAsync().AsTask().Result;
                    case "prev": return session.TrySkipPreviousAsync().AsTask().Result;
                    default: throw new ArgumentException("unknown transport command: " + command);
                }
            }
            catch (AggregateException) { return false; } // session closed mid-call
        }

        public static Dictionary<string, object> Now(string exe, bool withArt)
        {
            foreach (var session in Manager().GetSessions())
            {
                var id = session.SourceAppUserModelId ?? "";
                if (id.IndexOf(exe, StringComparison.OrdinalIgnoreCase) < 0) continue;

                GlobalSystemMediaTransportControlsSessionMediaProperties props;
                try { props = session.TryGetMediaPropertiesAsync().AsTask().Result; }
                catch (AggregateException) { continue; } // session closed mid-read (app quitting)
                var result = new Dictionary<string, object>();
                result["title"] = props.Title ?? "";
                result["artist"] = props.Artist ?? "";
                result["album"] = props.AlbumTitle ?? "";
                result["playback"] = session.GetPlaybackInfo().PlaybackStatus.ToString().ToLowerInvariant();
                result["artKey"] = props.Thumbnail == null ? null : props.Title + "|" + props.Artist + "|" + props.AlbumTitle;

                if (withArt && props.Thumbnail != null)
                {
                    using (var stream = props.Thumbnail.OpenReadAsync().AsTask().Result)
                    {
                        var size = (uint)stream.Size;
                        var buffer = new Windows.Storage.Streams.Buffer(size);
                        stream.ReadAsync(buffer, size, InputStreamOptions.None).AsTask().Wait();
                        result["mime"] = "image/png";
                        result["data"] = ScaleToPngBase64(buffer.ToArray());
                    }
                }
                return result;
            }
            return null;
        }
    }
}
