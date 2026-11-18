# Desktop acceptance

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
