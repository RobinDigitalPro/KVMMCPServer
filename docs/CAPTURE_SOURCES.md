# Capture sources, 0.9.1

Screenshots, recordings and video/combined recent buffers accept the same
optional `source`. Exactly one mode is selected. Omission keeps fullscreen on
the primary display. GPU cropping precedes CPU readback, scaling and encoding.
The same selection is used throughout a recording or buffer session.

```json
{"mode":"fullscreen","display":"primary"}
{"mode":"window","title":"Example - Application","match":"exact","area":"client"}
{"mode":"region","display":"primary","x":100,"y":150,"width":800,"height":600}
```

Use them as the `source` property of any of these calls:

```json
{"name":"hid_capture","arguments":{"token":"LEASE_TOKEN","source":{"mode":"region","x":100,"y":150,"width":800,"height":600},"format":"jpeg","maxWidth":800}}
{"name":"screen_record_start","arguments":{"token":"LEASE_TOKEN","source":{"mode":"window","title":"Example - Application"},"maxSeconds":60}}
{"name":"media_buffer_start","arguments":{"token":"LEASE_TOKEN","mode":"combined","profile":"light","source":{"mode":"window","title":"Example - Application"}}}
```

## Selection and geometry

- **Fullscreen:** primary-display Desktop Duplication, matching the previous
  default. The existing secure-desktop capture route remains available.
- **Region:** physical primary-display pixels, before scaling. Width/height
  must be at least two pixels. Bounds and source texture dimensions are checked
  before `CopySubresourceRegion`; invalid rectangles are rejected. Only the
  selected rectangle is staged and copied to CPU memory.
- **Window:** direct Windows.Graphics.Capture of one host window, including
  content behind other windows. Exact title matching is case-insensitive.
  `processId` optionally disambiguates; `area` is `client` by default or `window`
  for the complete window. Missing/ambiguous matches are errors. A guest window
  inside a virtual machine is not a host window: select the viewer window or a
  visible screen rectangle instead. Capture never focuses/restores the target.

Continuous sessions bind the resolved HWND, process ID and process creation
identity. Moving the same window is supported. Resizing, closing, hiding or
minimizing it stops continuous capture with a concrete reason. Reusing a title
or HWND does not redirect an active session. Subsequent standalone snapshots
can resolve a replacement window. Sources use 8-bit BGRA textures; unsupported
texture formats are refused rather than interpreted as different pixels.

Returned metadata includes `source.mode/backend/sourceId`, host `left/top`,
unscaled selected `sourceWidth/sourceHeight`, raw GPU `textureWidth/textureHeight`,
actual `readbackBytes`, and primary-display dimensions. Snapshots additionally
return `imageToHost` offsets/scales and `cursorInImage`; `cursor` remains in host
pixels. Map image coordinates with hostX = offsetX + imageX * scaleX, similarly Y.
Only then normalize against the **whole primary display** for absolute HID.
Never normalize a cropped rectangle to the whole HID range. Relative HID counts
are not guaranteed host or guest pixels. A separately rendered application cursor
can differ from the host cursor. Existing recordings/buffers report their selected
source bounds and output dimensions, from which the same scale can be calculated.

## Sharing, audio and source changes

One worker owns the selected capture pipeline. A running recording or visual
buffer pins its source. Same-source screenshots share that acquisition; another
source returns `source_busy`. With an active window recording, an omitted-source
screenshot still asks for fullscreen and is therefore refused: pass the same
window selector explicitly. Stop media before selecting another source.

Recording still stops the recent buffer first and never restarts it. Buffers
remain connection-owned, 30 seconds/32 MiB maximum, with the same fixed profiles;
recording remains limited to 600 seconds. The worker's existing OS CPU/private
commit limits and request bounds remain in force. A media-worker failure remains
separate from HID control.

System audio is still host render-endpoint loopback, even for a window or region;
window selection does not filter sound by application. Audio-only buffers reject
visual source selectors. Microphones and transcription are not used.

Window/region modes refuse secure-desktop capture and stop on a desktop change.
They never silently broaden to fullscreen or retarget another window. Fullscreen
keeps the existing secure-desktop behavior and consent controls.

## Freshness and latency

`capturedUtc` comes from the actual source-frame time; a repeated request no
longer makes a reused image appear newly captured. Read `frameSequence`,
`reusedFrame` and `frameAgeMs`. `maxWaitMs` (0..200, default zero) bounds waiting
for an available new frame on a warm snapshot. Initial source setup may take
longer. Pointer-only display updates do not claim a new scene-content timestamp.
A source frame still does not prove that an application consumed input.
The optional `afterActionId` idea in the original design is not part of this API.

Measured warm JPEG snapshots in one nine-sample test: window about 16 ms median,
region about 16 ms, fullscreen about 33 ms. The tested 320x240 region read back
307,200 bytes versus 8,294,400 for 1920x1080 fullscreen. These are fixture/test-load
measurements, not a speed guarantee; model and tool-dispatch latency remain.

## Reproduce

Build with `scripts/Build-Capture.ps1` and a Windows SDK containing C++/WinRT
capture headers. Run `ScreenCapture.exe self-test-sources` and `self-test-history`
without opening capture or HID. `Test-CaptureSources.mjs --live` verifies real
screenshots, decoded recordings/buffer exports, source changes and lifecycle.
`Test-CaptureSourcesMcp.mjs --live` checks the actual SDK/stdio/broker/native route,
a default 60-second recording and combined system audio/video export. Both use
an isolated external root and `test/CaptureFixture.cs`; neither injects HID.

References: [CreateForWindow](https://learn.microsoft.com/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow),
[CopySubresourceRegion](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-copysubresourceregion).
