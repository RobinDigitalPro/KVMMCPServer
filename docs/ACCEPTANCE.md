# Desktop acceptance

## Bounded native text-plan replies, 0.7.2

A 78-unit string reproduced the old native JavaScriptSerializer exception without
opening the HID device. Its actual live-protocol plan required 2111 JSON
characters, beyond the former 2048-character response limit. Planning failed
before the session could send its first text stroke; the resulting transport
failure correctly latched the controller stop.

The response limit is now 65536 JSON characters, with unchanged 8192-character
requests. Native planning also enforces 1024 normalized UTF-16 units and at most
2048 strokes. A synthetic worst-case full response takes 55510 characters. Plan
serialization failures are classified before output as no-input refusals;
unknown device/transport failures retain the existing stop behavior.

The native self-test passed 23 checks, including the complete maximum reply,
roundtrip and oversized-reply refusal. Seven read-only Windows planner cases
passed: short/78-unit/1024-unit ASCII, 1024 accented characters (2048 strokes),
and refusal of oversized, unsupported and normalization-expanding input. All
67 JavaScript/MCP regression tests passed. These tests do not claim that the
receiving application consumed typed text; that is checked separately on-host.

The on-host MCP test then typed the exact original 78-unit string into our own
visually checked receiver with Belgian (Period), interval 15 ms. The receiver's
actual text matched exactly. A 1025-unit request was refused with the field
unchanged; a native unsupported-Unicode refusal also left it unchanged. A
subsequent `MCP` typed successfully through the same live controller. Status
confirmed helper connected, physical-console session matched, and no stop/fault.
The failed text action was not replayed into its original application.

## Local operator UAC consent, service policy 0.8.0

On 2026-11-20 the protected service was updated and its status reported
`consentPolicy: recognized_prompt`, `policyVersion: 0.8.0`. Controller/MCP remains
0.7.1. The user explicitly requested removal of the per-executable allowlist.

A copy of the harmless elevated-token probe at a nonregistered operational
path was launched through ordinary Windows RunAs. A real `hid_capture` returned
its Winlogon consent screenshot. The actual MCP `hid_click` on Yes returned
`inputSent: true`, `secureConsent: true`; the program exited with code 0.
An earlier off-button click was refused without input or a controller fault.
The post-click capture returned to Default, and the lease was released.
The probe changes no host configuration. Initial bootstrap installation was
separate from this normal-MCP acceptance test.

Host receipts stay in the operational data directory, not the public repository.
No Windows UAC policy was disabled. Existing stale-prompt, caller/session,
deadline, credential and operator-stop checks remain in the code. Physical
Ctrl+Alt+F12 on Winlogon still requires the previously documented manual test.

## Base-layout detection correction, 0.7.1

An additional test after reloading the Codex MCP connection caught a false IME
classification of Belgian (Period). No input was sent on that refusal. The
planner now restricts mapping to loaded base layouts and checks for an associated
IME file instead of rejecting ordinary layouts on `ImmIsIME` alone. This Windows
compatibility issue is also described in the
[Chromium input implementation](https://chromium.googlesource.com/chromium/src/+/5e16d46c92747ae76914b9a5db114a19cdb00bde/ui/base/ime/win/imm32_manager.cc).
Layout variants and composition input remain unsupported.

The corrected executable passed nineteen native checks, including base/variant
classification, and the suite passed all 67 JavaScript tests. A fresh physical
MCP test matched the 59-character sample beginning with `MCP` exactly, followed
by the same accent, AltGr, Caps Lock, chord, click and refusal checks below.
The original Caps Lock state was restored. Agent documentation and the raw
keyboard tool description now explicitly distinguish held keys (which can
auto-repeat across tool round trips) from locally timed text and taps.

## Text, chords and atomic clicks, 0.7.0

The suite has 67 passing JavaScript tests and nineteen native checks. Three
tools add Windows-layout HID text, locally timed chords and single-call mouse
clicks. The SYSTEM consent service and kernel driver are unchanged.

A physical-console MCP test in our own foreground receiver matched the complete
55-character sample, including Belgian (Period) letters/digits, AltGr symbols
(`@`, euro, backslash, brackets and braces), direct accents, composed dead-key
accents (`êëôûï`), literal accents, Enter and Tab. A second mixed-case sample
matched with Caps Lock enabled; the original lock state was restored. Ctrl+Alt
completed, Ctrl+A selected the entire sample, and explicit-position/current-
position clicks each activated the receiver's test button once. An unsupported
emoji string was refused before its ordinary-text prefix could be typed.

`scripts/Test-ConvenienceInput.mjs --live ABS_HID_EXE ABS_OBSERVER_EXE ABS_DATA_ROOT`
reproduces this explicit test using the receiver built by `Build-Observer.ps1`.
Inspect its screenshot before sending `run`. The test uses an isolated data
root, ordinary user rights, and a topmost receiver above the paused target.
It never types into the paused application. A startup-failure regression also
checks that failed status publication closes the native transport.

## Individual keys and local timing, 0.6.0

The JavaScript suite has 55 passing tests. The official MCP SDK discovers all
fourteen tools and calls key down/up/press. Regression checks cover modifier
composition, six-key rollover, invalid durations, insufficient lease time,
cancellation, expiry, disconnect, explicit release and desktop transitions.
The unchanged HID helper passes its eighteen native wire checks.

The physical-console test used an independent foreground Raw Input receiver,
filtered to this virtual HID device. Right Shift down/up were both observed.
Timed F8 presses requested at 750 ms and 10000 ms were observed at 754.9 ms and
10017.1 ms respectively, including the entire long hold without heartbeat loss.
F8 was directed only to the empty receiver window. Timing is approximate.

Reproduce with `scripts/Build-Observer.ps1`, then run
`scripts/Test-KeyTiming.mjs --live ABS_HID_EXE ABS_OBSERVER_EXE ABS_DATA_ROOT`.
Inspect the emitted receiver screenshot before sending `run` on stdin. This
live script is excluded from ordinary tests and requires an idle controller.

## Secure desktop, 0.5.0

Actual consent screenshots, details expansion, the approved protected probe's
elevated exit code 0, refusal of an identical probe at an unapproved path, wrong
client rejection and expired screenshot refusal were verified. A ninety-second
MP4 crossed Default/UAC/Default twice, contained system playback audio and fully
decoded to 900 video frames plus 48-kHz stereo AAC. MCP emergency stop while UAC
was active released the controller and finalized the recording. Both ordinary
mouse collections worked again after returning to Default. The physical
Ctrl+Alt+F12 chord on UAC still needs a manual test; see
[secure desktop scope](SECURE_DESKTOP.md).

## System playback audio, 0.4.0

The JavaScript suite has 41 passing tests, including default-enabled system
audio, explicit opt-out and unavailable-audio metadata. The user-mode helper
builds with warnings treated as errors; the HID kernel driver is unchanged.

On 18 November 2026 the host initially had no active render endpoint. An actual
recording requested system audio by default, returned audio=false with an
unavailable reason, and still produced a finalized, decodable video. After
separate installation of the publisher's signed virtual cable, actual Windows
playback/loopback was checked:

- A five-second 1280x720 recording contained a 48-kHz stereo AAC track and 75
  video frames. A quiet test WAV was played through Windows, not supplied to the
  recording encoder; the resulting AAC decoded to end-of-stream with nonzero
  signal (observed peak 1156, normalized RMS approximately 0.0135).
- Explicit systemAudio=false produced a video-only MP4 and disabled metadata.
- A full one-minute real-loopback run completed with 900 video frames and
  2880000 submitted stereo PCM frames. AAC decoded to end-of-stream at 48 kHz,
  stereo, with test signals near 993 ms and again through 59233 ms. The decoded
  container audio duration was 60010 ms because of AAC block padding; native
  video/source duration was 60000 ms. Both early and late playback were present.
- A separately marked synthetic diagnostic tested the same muxer/clock without
  an endpoint. A pulse beginning at 500 ms and ending at 2000 ms decoded at
  approximately 499..1999 ms. This is timing/mux evidence, not real loopback
  evidence. Its source cannot be selected through MCP.
- An earlier real-loopback attempt was interrupted by DXGI display access loss;
  it finalized its partial video and captured audio. The successful retry is
  separate evidence; desktop-transition support is not claimed.

AAC block padding can extend a short container by less than one 1024-sample
block. The user-facing 600-second limit and native source-sample deadlines
remain enforced. Microphone capture and secure-desktop support were not added.
The latter has a separate [design investigation](SECURE_DESKTOP_PLAN.md).

## Screenshots and recording, 0.3.0

On 18 November 2026 the separate user-mode DXGI/WIC/Media Foundation helper
built with warnings treated as errors. The JavaScript suite has 39 passing
tests, including recording ownership, input-lease independence, cancellation
during start, disconnect cleanup, single-recorder exclusion and duration bounds.

Explicit capture-only live tests sent no mouse/keyboard input and verified:

- Full-size 1920x1080 PNG, downscaled JPEG and PNG, with source-coordinate metadata.
- Warm resized snapshots in roughly 36..83 ms in short host observations;
  first-process/startup snapshots were approximately 310..330 ms. These are
  observations on one host, not a general benchmark or latency guarantee.
- A two-second 1280x720, 15-fps recording finalized with 30 frames, and its MP4
  decoded back to a visually checked first-frame PNG. Cursor alpha was flattened
  before scaling to prevent a black cursor rectangle.
- Early stop of a request configured for 600 seconds.
- A later one-minute run through the official SDK/stdio/broker path completed
  automatically at 60000 ms. The 1280x720 MP4 was approximately 8.2 MB and a full
  decode reached end-of-stream with 900 video frames, container duration 59999 ms
  and final-frame timestamp 59933 ms. Native sample submission counted 899 frames;
  the encoded/decode frame count can differ due to media-pipeline timing.
- Direct native rejection of 601 seconds, independently of MCP validation.
- Parent-pipe EOF finalized a partial recording; missing heartbeat stopped and
  finalized a recording after approximately five seconds from the last ping.
- Two official SDK clients over stdio and the authenticated local broker saw
  eleven tools. Actual screenshots/MP4 recording completed; a second connection
  could not stop the owner's recording. Owner disconnect finalized recording.
  That isolated harness suppressed HID writes; the active desktop controller
  serving another chat was not restarted for these capture tests.

Quick acceptance uses a two-second deadline; the one-minute run is additional
duration coverage. A full ten-minute endurance
run and lock/UAC/display changes during recording remain separate acceptance.
No livestream or audio capture was added. Operational evidence stays outside Git.

## Controller/MCP 0.2.0

The installed kernel driver remains 0.1.0. User-mode controller changes use the
official MCP SDK 2.4.0 and are covered by 31 JavaScript tests plus the native
helper's 18 self-checks. Additional verified behavior:

- Two real stdio SDK clients share one local controller; concurrent startup is
  also tested in simulation.
- Leases bind to the acquiring connection; a borrowed token is refused.
- Operator stop survives controller restart and is honored from the local stop
  file independently of an MCP connection.
- Emergency stop interrupts pending capture and split movement; official SDK
  cancellation reaches the controller and releases its lease.
- A late cancellation cannot release a newer lease.
- A live physical-console SDK run received relative and absolute movement and a
  1920x1080 PNG. Disconnecting the first client independently released its held
  Shift key in 34 ms in the first 0.2.0 run.
- Local endpoint authentication rejects invalid credentials, including malformed
  Unicode input; the controller binds only 127.0.0.1.

The endpoint credential/stop state are protected for the current Windows user
and SYSTEM. That does not isolate arbitrary programs sharing the same user.
Owner/job labels are descriptive. Broader device ACL and Driver Verifier work
below remains pending.

## Driver 0.1.0 and initial host input

Measured on the physical host on 17 November 2026 with development-signed
OpenDesktopHID 0.1.0. The controller ran without an administrator token in
physical-console session 1; primary display 1920x1080. Independent Raw Input
reception and cursor measurements establish delivery, rather than a write ACK.

| Test | Result |
| --- | --- |
| JavaScript reports/descriptors/session/MCP | Passed; malformed requests, ownership, expiry and capture lease checks |
| Native wire/session checks | Passed: 18 checks |
| Portable C report contract | Passed: 12 checks |
| VHF build/signability | Passed, zero errors/warnings; warm build 5689 ms |
| Package validation/rejection | Passed: four cases, including corrupt SYS and changed manifest |
| Installation | Passed, device and collections started; no further reboot requested |
| Relative movement | Requested dx=10, dy=5 received exactly; cursor moved 10,5 in this setup |
| Absolute movement | Pixel 360,211 via HID 6147,6408; measured cursor 360,211 |
| Click and drag | Left down/up received; dx=10 drag occurred between down/up |
| Wheel | One detent received as wheel data +120 |
| Keyboard | Usage 4 make/break, scan 0x1e; Q on Belgian AZERTY |
| Modifier combination | Left Shift plus usage 4 make/break received |
| Native heartbeat loss | Held Shift released after 2106 ms; stopped/released reported |
| Kernel watchdog | Own helper forcibly terminated; independent release after 3100 ms |
| Live MCP | Eight tools; input, second owner rejected, emergency stop releases and blocks reacquisition |
| MCP capture | Valid 1920x1080 PNG visually checked; session/time/cursor metadata |
| RDP mismatch | Actual startup refused before input; physical-console run passed |
| Normal-user operation | Live helper reported administrator=false |

A prior RDP attempt acknowledged reports without delivering input to its test
window. That failure is retained in the evidence. Session guards were added
before successful console tests. Failed screenshot attempts are also retained.

## Still to validate

- Physical Ctrl+Alt+F12 takeover; API emergency stop passed separately.
- Lock/unlock and UAC transitions: predicates are tested, no live secure-desktop
  interaction was performed.
- Other display layouts/DPI, secondary displays and negative coordinates.
- Elevated applications and exclusive-fullscreen/protected-video capture.
- Power transitions, OS failures, concurrency under Driver Verifier and device
  ACL isolation between Windows users.

Keep per-run JSON, receiver logs, PNGs, host readiness, binary hashes and source
manifest in the external operational data area. The installed kernel package
remains pinned separately from subsequent user-mode helper changes.

This is a tested development prototype. Complete workstation control,
secure-desktop access and crash-proof recovery are not claimed. No production-signed driver distribution is provided.

## Direct coding-agent chat, 18 November 2026

Actual MCP tool calls in an existing local chat verified a usable 1920x1080
desktop image, relative movement from (999,507) to (1009,512), absolute movement
to (800,450), and left-button down/up at that position. Independent Raw Input
and cursor measurements confirmed delivery. This was not a standalone SDK
substitute for the chat integration.

The first image was black and is a failed observation. Later images were usable.
Focus loss caused an input batch to be released without sending a movement.
The optional keyboard step was skipped when another application was foreground.
The final lease was released and no held input remained. These findings do not
validate unattended screenshot reliability, other displays or every agent role.
