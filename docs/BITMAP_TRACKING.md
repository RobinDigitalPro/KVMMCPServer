# CPU bitmap tracking and ad-hoc search

0.10.0 adds four MCP tools. Tracking matches a caller-provided PNG
against pixels; it does not use an AI model, native cursor position as its
detection result, or a guest agent. None of these tools moves or clicks.

## Calls

`activate_tracking` takes an input lease token, `bitmapPngBase64`, optional
`source`, `anchor`, `includeCursor`, `minScore` and `minMargin`. The source is the
same fullscreen/primary, physical-pixel region or exact named host window used
by [capture sources](CAPTURE_SOURCES.md). Omission means primary fullscreen.
It performs one bounded initial search and returns `trackingId` plus status.

`locate_tracking {trackingId}` returns the tracked measurement. **Only in lost
state** does this explicit call perform one full search and resume on success.
Tracking and stopped states never trigger a full search. `hid_status` reads
cached tracking state without causing a search, including while lost.

`stop_tracking {trackingId}` stops matching and is idempotent for the current
ID. A stopped tracker requires a new activation. On disconnect, emergency stop
or controller shutdown, matching is stopped. Releasing an input lease leaves
the connection-owned tracker running. Another connection cannot locate/stop it.

`locate_bitmap` takes the same options plus an input lease and performs exactly
one bounded ad-hoc search. It creates no tracker. Duplicate convincing matches
return ambiguous rather than silently selecting an icon.

```json
{"name":"activate_tracking","arguments":{"token":"LEASE","source":{"mode":"window","title":"Example app"},"bitmapPngBase64":"PNG_BASE64","anchor":{"x":1,"y":1},"includeCursor":false}}
{"name":"locate_tracking","arguments":{"trackingId":"TRACKING_UUID"}}
{"name":"stop_tracking","arguments":{"trackingId":"TRACKING_UUID"}}
{"name":"locate_bitmap","arguments":{"token":"LEASE","source":{"mode":"region","x":100,"y":100,"width":800,"height":600},"bitmapPngBase64":"PNG_BASE64"}}
```

Load base64 from a local lossless PNG in client code; do not paste large image
strings into an agent prompt. Both tools accept at most 32 KiB encoded PNG
bytes. Templates for tracking are 2..48 pixels per dimension; ad-hoc templates
are 2..128. Larger templates are rejected, not resized. Pixel chunks are kept;
metadata and animation are not accepted as image-processing instructions.
PNG alpha below 200 is excluded from comparison; at least eight opaque pixels
are required. A screenshot crop usually includes background: supply alpha to
mask it when tracking a cursor over changing scenery. No scale search is done.

## Coordinates and results

`position` is the supplied anchor inside the matched bitmap; its default is the
bitmap center. For a pointer, explicitly supply its click hotspot. `bounds`
contains the template top-left and dimensions. Both are **unscaled pixels
relative to the originally selected source**, never to the moving 128x128
internal search rectangle. Host source origin/dimensions are returned separately.

Results include state, reason, frame ID, observed timestamp, measurement age,
match/runner-up scores, search counts, timing and worker resource measurements.
While lost/stopped, position and bounds are null. `lastKnownPosition`, frame ID
and observed time remain historical. A recent measurement does not establish
that the application has consumed a later input event.

Scores are similarities, not statistical confidence. Defaults are minScore=.95
and minMargin=.02. The matcher uses opaque pixels, a bounded color-anchor
rejection stage and mean absolute RGB error with spatial suppression of nearby
peaks. Occlusion, changed appearance, scaling or damaged anchor pixels can cause
loss. It does not update its template automatically or infer cursor semantics.

## Processing and limits

- One CPU tracker. The following region is 128x128, clamped to source bounds.
  With a 48x48 template centered there is about 40 pixels of travel per axis.
- Process new available image observations; keep the latest, never an expanding
  frame queue. Window frame-arrival hints avoid repeatedly reading an unchanged
  image. Periodic liveness checks still detect hidden/closed/resized windows.
- Owned GPU source pixels are shared with capture/media. Only the tracking ROI
  is staged to CPU (65,536 BGRA bytes for 128x128). No tracking encoder is added.
  Where the D3D11 device supports fences, a native GPU completion event avoids
  spinning on the CPU while a readback copy is pending. The reported adapter
  and readbackSync identify the actual path; unsupported devices use Map.
- The native path uses Windows.Graphics.Capture for named windows, DXGI desktop
  duplication for primary/region sources, D3D11 textures/copies and WIC for PNG.
  The CPU matcher is project code. Direct2D image effects do not replace the
  position/ambiguity search. See Microsoft's [capture overview](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture),
  [D3D11 queue signal](https://learn.microsoft.com/en-us/windows/win32/api/d3d11_3/nf-d3d11_3-id3d11devicecontext4-signal)
  and [fence completion event](https://learn.microsoft.com/en-us/windows/win32/api/d3d11_3/nf-d3d11_3-id3d11fence-seteventoncompletion).
- A tracker, including lost state, pins the selected source until stop. Same
  source screenshots/recordings/buffers may share it. Different sources return
  source_busy. A lost tracker stops matching and releases an otherwise unused
  capture session; an explicit lost locate recreates the same source safely.
- Full search: at most 8,388,608 source pixels and 150 ms matching time. Local
  matching has an 8 ms time budget. Incomplete search returns search_budget,
  never a verified partial result. Capture initialization/wait is additional.
- Existing OS worker CPU (5% of host capacity) and private commit (512 MiB)
  limits remain. Matching resource pressure stops the tracker; HID remains in
  its separate helper. No kernel driver or secure-desktop service changes.
- Tracking is ordinary-desktop only. Session/desktop/identity changes stop it;
  a missing template or recoverable geometry change can produce lost. Secure
  desktop capture continues through its existing route after source unpinning.

## Acceptance before release

`scripts/Test-BitmapTrackingMcp.mjs --live ABS_CAPTURE ABS_FIXTURE NEW_ROOT 60 48`
uses the actual official SDK -> stdio -> broker -> native chain. It creates an
occluded non-activating fixture with a moving software cursor and suppresses
all HID writes. It verifies exact source coordinates, owner isolation, lease
release, explicit lost recovery, stopped behavior, ambiguity and disconnect.

The performance gate requires a minute run, no input, warm match p95<=2 ms,
measurement-age p95<=100 ms, average and maximum rolling ten-second CPU
increments<=2 percentage points above a settled idle baseline, private
bytes<=256 MiB and >=45 processed observations/second on the fixture. CPU is
calculated independently from cumulative process CPU/wall counters and logical
processor count. The existing short-window reading and peaks are retained;
they are not substituted for cumulative measurements.
These are test gates for this workstation, not performance promises for every
game or GPU. An optional final expected-caller-thread UUID binds the release
gate to the actual CODEX_THREAD_ID inherited from the executing chat. Never
override that runtime identity. The existing main chat must run and inspect
acceptance before release; a successful local performance run is insufficient.

Live capture must run as the ordinary interactive console user with access to
Windows graphics capture. A restricted execution account can fail during WGC
initialization even if Node, filesystem access and the MCP handshake work.
That failure is not a completed performance test. Do not install services or
grant administrator rights to work around an acceptance runner's sandbox.
