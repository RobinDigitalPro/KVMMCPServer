# Screenshots and bounded screen recording

Version 0.4.0 uses a persistent, user-mode `ScreenCapture.exe` beside
`HidTransport.exe`. Screenshots and H.264/MP4 recordings use the primary physical
display. System playback audio is included by default when an active default
audio output and AAC encoder are available. No microphone, livestream or network
listener is opened. The capture code requires no HID-driver change, administrator
grant or new boot-security setting. Installing an optional audio device is a
separate administrator action.

## Build and enable

Use the existing EWDK C++ toolchain and Windows SDK (26100 on the tested host):

```powershell
.\scripts\Build-Capture.ps1 -EwdkRoot E:\ -OutputDirectory D:\AgentData\desktop-hid\native
```

The capture executable uses Windows DXGI Desktop Duplication, WIC and Media
Foundation; it has no downloaded runtime dependencies. Encoding permits Windows
hardware transforms but does not guarantee a particular hardware encoder. Output
is BGRA copied from GPU to CPU, with optional WIC downscaling; this is not a
zero-copy GPU encoder. No proprietary capture SDK is bundled.

Do not replace running executables or restart a controller that another agent is
using. Stage a versioned build, arrange an idle checkpoint, close the controller
normally, copy the reviewed executable and source, then start it again. Reload
the MCP connection so its catalog contains seventeen tools. A running 0.2.0 adapter
or controller keeps its old code until restarted. Never clear an operator stop
as part of an upgrade. See `hid_status.screenRecording` for availability.

The supplied updater refuses to act while any MCP clients are connected, input
is leased, capture is pending, recording is active or controller status is stale.
Finish work and close the MCP connection before running it from the reviewed
Git checkout. It backs up installed source/configuration to the operational
data root, copies only tracked source plus the reviewed capture executable,
verifies hashes, preserves operator stop and starts the new controller:

```powershell
.\scripts\Update-Local.ps1 -Configuration D:\InstalledSource\deployment.local.json -CaptureExecutable D:\AgentData\capture-build\ScreenCapture.exe -ConfirmIdle
```

Then reload the MCP connection. The updater does not change the registered
source path, driver, account rights or Windows security settings. If a copy or
startup fails, inspect the backup/logs before resuming; it does not clear faults
or automatically roll back the installation.

## Screenshot

Acquire a short input lease, then call the existing tool:

```json
{"name":"hid_capture","arguments":{"token":"LEASE_TOKEN","format":"jpeg","maxWidth":1280,"includeCursor":true}}
```

Default format is PNG and default size is the full primary display. The new
backend includes the cursor by default where available. `maxWidth` accepts
320..3840 and only downscales, preserving aspect ratio. Returned `width` and
`height` describe the image. `sourceWidth`, `sourceHeight` and `cursor` describe
physical desktop pixels: map a click in a resized image back to source pixels
before converting to absolute HID coordinates. Session IDs and observation time
accompany each frame. A static desktop can reuse the last duplication texture
after checking for updates; no old frame is returned after duplication loss.

Cursor hiding is best effort: an OS-composited pointer can already be part of
the desktop image. Cursor overlays are flattened to opaque RGB before scaling.
PNG/JPEG files are under `captures/`. The image is also returned inline through
MCP. Without ScreenCapture.exe, legacy default PNG capture remains available;
JPEG, resizing and cursor overlay require the new helper.

## Product demo or automated test

Start while holding a valid input lease. The call returns a recording ID
immediately after the encoder starts; do not hold a ten-minute MCP tool call.

```json
{"name":"screen_record_start","arguments":{"token":"LEASE_TOKEN","maxSeconds":600,"fps":15,"maxWidth":1920,"bitrate":6000000}}
{"name":"hid_release","arguments":{"token":"LEASE_TOKEN"}}
{"name":"screen_record_status","arguments":{"recordingId":"RECORDING_UUID"}}
{"name":"screen_record_stop","arguments":{"recordingId":"RECORDING_UUID"}}
```

The maximum is **600 seconds**, default 600, minimum 1. Both the MCP schema and
native worker reject larger values. The native worker enforces its own monotonic
deadline, independent of client polling and Node timers. `fps` is 1..30 (default
15), `maxWidth` is 320..3840 (default 1920), bitrate is 1..20 Mbit/s (default 6).
The encoder rounds dimensions down to even pixels. FPS is a target: slow capture
or encoding can drop frames, with timestamps preserving elapsed time. At a
nominal 6 Mbit/s, ten minutes is approximately 450 MB before container overhead;
actual size depends on the encoder and screen content.

Only one recording runs per controller. It belongs to the connection that
started it, not to a human-readable owner label. That connection can inspect or
stop it after releasing/expiring its input lease. Other agents may subsequently
control the desktop, so a recording can include their actions. Keep the same
MCP connection open for the entire recording. Another connection cannot take
over its recording ID. Status/stop address the most recent recording owned by
that connection; files/receipts remain available after completion.

The native helper writes `recordings/UUID.partial.mp4`, finalizes the container,
then renames it to `UUID.mp4`. A JSON receipt records dimensions, frame count,
duration, timestamps, state and reason. Treat a file as ready only when
`finalized=true`. Stop is idempotent after completion. On an abrupt process kill,
OS failure or failed finalization, a partial file can remain unrecoverable.

Disconnect, controller shutdown, emergency stop, unsupported secure desktop, session
change and display-dimension change stop the recording. Parent-pipe EOF also
stops it, and loss of the capture worker's one-second controller heartbeat
stops it after five seconds without a ping. These are separate from the HID
watchdogs. No automatic resume, unlock, session transfer or input replay occurs.

The optional 0.5.0 [secure desktop service](SECURE_DESKTOP.md) supplies fresh
SYSTEM/GDI frames for actual Windows consent dialogs while encoding and audio
remain in the ordinary recorder. Short source-transition gaps are black frames,
not stale screenshots. Receipts count secure frames and desktop transitions.
Installation and real UAC acceptance must be verified separately on each host.

Keep output on the external operational disk/share. Files are not uploaded to
GitHub. Product demos have cursor video and system audio when available, never
microphone audio. An MP4 resource path does not guarantee that an AI client can decode
video; inline screenshots remain the universally supported observation route.

## Small acceptance checks

Ordinary tests do not capture the desktop or inject input:

```powershell
node --test test/*.test.mjs
```

Explicit live tests observe the desktop but send no mouse or keyboard input:

```powershell
node scripts/Test-CaptureLive.mjs --live D:\AgentData\desktop-hid\native\ScreenCapture.exe D:\AgentData\capture-tests\smoke
node scripts/Test-CaptureSafety.mjs --live D:\AgentData\desktop-hid\native\ScreenCapture.exe D:\AgentData\capture-tests\safety
node scripts/Test-CaptureMcp.mjs --live D:\AgentData\desktop-hid\native\ScreenCapture.exe D:\AgentData\capture-tests\mcp
# Optional longer run (seconds, up to 600):
node scripts/Test-CaptureMcp.mjs --live D:\AgentData\desktop-hid\native\ScreenCapture.exe D:\AgentData\capture-tests\minute 60
```

The first checks three snapshots, a two-second automatic stop, first-frame MP4
decoding and early stop of a 600-second request. The second talks directly to
the native pipe to verify rejection of 601 seconds, parent EOF and heartbeat
loss. A full ten-minute endurance run is separate from these quick checks.
The third uses two real official SDK clients over stdio, an isolated authenticated
broker and the actual capture worker; HID writes are suppressed in that harness.
An optional duration argument selects 1..600 seconds (default 2). A full
one-minute MCP recording was also decoded to end-of-stream with 900 frames.
Rotated/multiple monitors, other DPI/HDR layouts, protected content and
exclusive fullscreen remain unvalidated. A locked desktop is refused.

## System playback audio (0.4.0)

`screen_record_start` defaults `systemAudio` to true. WASAPI shared-mode loopback
opens only the default **render** endpoint (console role). Windows converts its
mix to 48-kHz, 16-bit stereo PCM and Media Foundation writes a 160-kbit/s AAC
track into the same MP4. No microphone endpoint is requested. Set
`systemAudio=false` to explicitly request video only; no extra permission is
needed for ordinary loopback capture.

The recording response/receipt includes `systemAudioRequested`, `audio` (track
present), `audioSource`, `audioStatus`, `audioReason`, `audioSampleRate`,
`audioChannels`, `audioFrames`, `audioCapturedFrames`, `audioPeak` and
`microphone=false`. `audioStatus` starts as capturing and ends as captured;
unavailable/disabled/interrupted explain missing, opted-out or disrupted audio.
An audio track can correctly contain silence; track presence does not prove
audible application sound. An unavailable endpoint or encoder does not prevent
video recording. If an active endpoint fails mid-recording, the AAC track is
retained with silence and an interrupted status/reason. Changing the default
playback device is not automatically followed; start a new recording afterward.

Audio packets use WASAPI/QPC timestamps on the recording timeline. Missing
packets during silence are padded, with 100 ms left for delayed packets while
recording. Final PCM is capped to the recording deadline. AAC uses 1024-sample
blocks, so shorter recordings can have up to one AAC block (about 21.3 ms) of
container padding. The 600-second ceiling at 48 kHz is an exact AAC-block
multiple. Sources played to a different output, exclusive/protected audio and
hardware-offloaded streams are not guaranteed to be captured.

On a host with no active audio output, install/enable an appropriate playback
device separately. One option is [VB-CABLE](https://vb-audio.com/Cable/), a
third-party donationware driver. Download from its publisher; it is not bundled
with this MIT project. Choose CABLE Input as the playback output. Loopback uses
that render endpoint; the CABLE Output recording endpoint is not used. The
ordinary microphone remains outside the capture path.

Explicit audio acceptance (plays a quiet two-second test tone when an output
is available):

```powershell
node scripts/Test-CaptureAudio.mjs --live D:\AgentData\desktop-hid\native\ScreenCapture.exe D:\AgentData\capture-tests\audio
# Optional one-minute real-loopback run:
node scripts/Test-CaptureAudio.mjs --live D:\AgentData\desktop-hid\native\ScreenCapture.exe D:\AgentData\capture-tests\audio-minute 60
```

It checks a separately marked synthetic diagnostic source, decoded AAC timing,
actual Windows playback/loopback when available, missing-output fallback and
explicit audio opt-out. `self-test-av` is an explicit native diagnostic; the MCP
record command cannot select its synthetic source. Never treat synthetic test
results as evidence of real endpoint capture.
