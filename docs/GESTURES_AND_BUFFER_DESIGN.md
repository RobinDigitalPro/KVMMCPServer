# Relative gestures and bounded recent-media buffer

Implementation specification agreed on 20 November 2026. The three features are
relative move-and-click, relative drag, and one recent-media buffer. Existing
production control stays online until its main chat acknowledges a safe update
checkpoint. No kernel HID driver change is required.

## Relative gestures

`hid_move_click_relative(token, dx, dy, button?, pauseMs?, durationMs?)` moves with
no held mouse button, waits locally, presses/releases one button, and returns
acknowledgement metadata. Defaults: left, 50 ms pause, 80 ms hold. Displacements
are integer HID counts in -32767..32767, pause 0..1000 ms, hold 1..1000 ms.

`hid_drag_relative(token, dx, dy, button?, durationMs?, holdMs?)` presses a button,
waits an optional initial hold, follows a bounded linear sequence of relative
reports, then releases. Defaults: left, 500 ms movement, 50 ms initial hold.
Movement duration is 1..5000 ms, initial hold 0..1000 ms, total action <= 6000 ms.
Counts sum to the requested displacement. OS/guest acceleration still applies.

Both operations occupy one existing serialized input action. They require a
fresh valid connection-bound lease, ordinary physical console, no already-held
mouse buttons and enough remaining lease time. They preserve keyboard state on
success. Every wait is cancellable and rechecks the session/lease. Cancellation,
disconnect, expiry, operator stop and transport errors attempt neutral input;
the existing independent native/kernel watchdogs remain. Unknown input outcomes
are reported and never replayed. No rollback of an already applied movement is
claimed. Relative gestures never operate UAC buttons.

## Buffer API

Four tools are added:

| Tool | Parameters | Result |
| --- | --- | --- |
| `media_buffer_start` | token, mode, profile? | bufferId and actual effective configuration |
| `media_buffer_status` | bufferId | owner-scoped current/final state and measurements |
| `media_buffer_stop` | bufferId | idempotent stop; frozen available history |
| `media_buffer_export` | bufferId, seconds | immutable exported file and actual time range |

Mode is exactly one of `audio`, `video`, `combined`. No independent simultaneous
audio/video buffers. Combined export is one MP4 file with synchronized sound and
picture; internal codec streams are an implementation detail. Audio export is
an audio-only container. There is no microphone, speech recognition or transcript.

Profiles are a fixed allowlist; callers cannot provide resolution, sample rate,
channel count or arbitrary codec configuration:

| Profile | Maximum video size | FPS | Video bitrate | Audio |
| --- | --- | --- | --- | --- |
| light | 640x360 | 5 | 1 Mbit/s | 48 kHz, stereo, 16-bit source, AAC 160 kbit/s |
| standard (default) | 1280x720 | 10 | 2 Mbit/s | same |
| high | 1920x1080 | 15 | 4 Mbit/s | same |

The primary desktop is downscaled only, preserving aspect ratio. Video profile
properties are irrelevant in audio-only mode. Profiles are ceilings to test on
this host, not claims of measured resource use. Both JS and native code enforce
the allowlist independently. Buffer age is <= 30 seconds, bounded independently
by retained encoded bytes. Available history can be shorter during warmup,
after eviction or encoder/keyframe alignment. Responses always report the actual
start/end/duration; exact-duration re-encoding is not performed implicitly.

## Mutual exclusion, ownership and lifetime

One global media transition lock serializes start/stop/export/record transitions.
A start requires the existing input lease, then buffer lifetime is independent
of that short lease and bound to the authenticated MCP connection. A different
connection cannot export or stop its buffer. Descriptive labels are not authority.

`screen_record_start` first validates its request and authorization, then stops
the buffer with reason `recording_started`, and only then starts recording. It
never runs both encoders at once. If recording initialization fails, the buffer
remains stopped, with an explicit result; no silent restart. A buffer start while
recording is active returns `MEDIA_BUSY`. Finishing recording does not restart
the buffer. Ordinary still screenshots remain available.

Manual/resource stops freeze complete retained history for the owning connection
until a new buffer replaces it or the owner disconnects. Export of frozen data
cannot restart capture. Export is refused while recording is active. Disconnect,
operator stop and controller shutdown stop processing; disconnect clears retained
private media. Secure-desktop/session/display changes stop the background buffer
explicitly. Existing explicit screenshot/recording UAC behavior is retained.

## Resource boundaries

Media is processed outside the HID helper/kernel, with OS-enforced CPU/private-
memory limits on the media worker and any export child. Initial process ceiling:
5% total CPU, 512 MiB committed private memory. Encoded history has a separate
32 MiB byte ceiling plus bounded container/parser overhead. One export snapshot
and one bounded in-flight fragment are allowed; request queues are bounded.

Capture/encoding runs once, not through repeated MCP screenshot calls. Retain
encoded media in RAM; write only explicitly requested exports and metadata to
the configured external data root. No continuous rotating disk recordings.
One encoder configuration is active, and recording replaces buffering.

Measure CPU, private memory, late/dropped frames and real buffered duration.
Sustained overload stops the buffer with a structured reason before queues grow.
No automatic mode change or unbounded software fallback. Any selected encoder
must remain inside the same OS resource ceilings. If those limits cannot be
installed, reject buffer startup. GPU/driver bugs cannot be absolutely excluded;
bounded profiles and live load tests are also required.

A media-only failure updates media state and releases its worker. It must not
persist a HID operator-stop or stop a VM. Native HID faults retain their current
stop semantics. Loss of current visual observation never authorizes blind input.

## Status, errors and notifications

Status includes bufferId, mode, profile, state, reason, started/stopped UTC,
availableSeconds, bufferedBytes, effective encoding, process resource limits,
CPU/private-memory measurements, droppedFrames and a monotonic event sequence.
`hid_status` includes a small media summary. Retain the latest terminal state
after stop/failure so the reason remains inspectable.

Reasons include requested, recording_started, owner_disconnected, operator_stop,
controller_shutdown, cpu_budget, memory_budget, buffer_byte_limit,
encoder_error, audio_unavailable, secure_desktop, session_changed,
display_changed and worker_disconnected. Invalid arguments and capacity errors
return bounded failures without terminating healthy HID control.

The four tool calls and persistent status are the authoritative API. Surface
important unseen owner events in subsequent tool results. Optional MCP resource
change notifications may be sent to subscribed clients, but do not claim that a
generic notification automatically wakes an AI model. Never add periodic model
polling or route buffer notifications to an unrelated chat.

## Acceptance and rollout

1. Test gesture totals, ordering, local pause, held-button refusal, cancellation,
   lease expiry, disconnect, stop, desktop transition and lost acknowledgements.
2. Test all modes/profiles and both JS/native rejection of invalid options.
3. Validate >30-second buffering, 5/15/30-second exports, warmup/byte eviction,
   independent decoding, actual tracks, A/V timing, timestamp and keyframe bounds.
4. Test mutual exclusion in both directions, concurrent starts/exports, owner
   isolation, cancellation, parent EOF, worker failure, bounded queues and limits.
5. Test resource limits actually installed, slow encoders, low-memory admission
   refusal, and media failure leaving the native HID connection healthy.
6. Run live tests with the existing visible receiver/controlled test playback;
   never replay gestures into the active VM. Measure idle and moving desktop,
   then approved build/VM load. Do not invent unmeasured CPU/GPU guarantees.
7. Notify `Route all main Codex work here` before deployment. Obtain a safe
   checkpoint, released lease and finalized recording. Only then activate,
   reload the MCP catalog if needed, verify 23 tools, capture/control/media,
   publish exact receipts and tell the main chat it may resume.

Source/setup lives outside operational data. All buffers, build/test artifacts
and exported clips belong to the configured NetworkShare data directories.
