# Secure desktop capture and input: investigation

Status: design investigation implemented as a 0.5.0 candidate. Normal UAC remains
enabled. Host installation and real secure-desktop acceptance are still pending;
compiler/unit tests alone do not establish UAC support. Current setup, precise
scope and limits are in [SECURE_DESKTOP.md](SECURE_DESKTOP.md).

## What blocks the current implementation

HidTransport.cs checks the physical console and Default input desktop before
sending reports and in its watchdog. ScreenCapture.cpp applies the same
desktop guard. These are deliberate user-mode checks, separate from the VHF
driver's ability to deliver keyboard/mouse input. Delivery on the normal desktop
does not establish delivery or correct session routing at a UAC prompt.

Removing those checks alone would not supply secure-desktop images. Microsoft's
[DXGI DuplicateOutput documentation](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput)
states that secure-desktop access requires LOCAL_SYSTEM. Simply elevating the
ordinary recorder to an administrator is not the proposed capture solution.

## Proposed architecture

Keep the ordinary MCP adapter/controller and system-audio capture under the
interactive user. Add a separate, small privileged broker installed through an
explicit administrator action, plus a bounded capture helper in the target
physical-console session. The broker cannot capture the user's display from
Session 0. Microsoft documents separate per-session applications and secured
IPC in [Interactive Services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services).
Its example describes normal user-context UI; a SYSTEM helper bound to the
secure desktop is a design inference that must be prototyped and validated.
Do not use SERVICE_INTERACTIVE_PROCESS or disable secure-desktop UAC policy.

The helper must run as SYSTEM in the correct interactive session and bind to
the active input desktop. Recreate DXGI duplication after an authorized desktop
transition and annotate every frame with session, desktop and timestamp. Keep
recording time continuous, record transition gaps explicitly and never present
a cached Default-desktop frame as an image of a UAC prompt.

Install service/helper executables in an administrator-controlled directory,
such as Program Files, with checked hashes/signatures. Writable source/share
directories must not become SYSTEM executable locations. Runtime recordings
remain in the configured operational data root. All service output paths must
be narrowly validated; ordinary agents must not be able to turn privileged file
writes or child-process launching into general SYSTEM execution.

Expose a small local IPC protocol with a DACL restricted to the configured
operator SID and SYSTEM, bound to session and connection, with short-lived
authorization. Limit operations to capture and fixed HID report types. No
arbitrary executable, shell command, registry operation or credential entry API.
Human-readable owner/job labels alone do not grant privileged access.

Approving elevation grants administrator execution to the pending application.
Require a specific operator-authorized elevation request, tied to the expected
program/publisher/hash and current consent dialog, before permitting input on
the secure desktop. Preserve the existing emergency stop, independent driver
watchdog, connection ownership and input-neutral cleanup. A normal short input
lease must not implicitly authorize every future UAC prompt.

## Small proof steps

1. Read-only SYSTEM/session prototype: capture one known UAC prompt to an
   external test artifact; verify session and actual image, then stop.
2. Test one authorized fixed HID action against a benign, identified elevation
   request. Independently observe the result; establish whether VHF routing works
   unchanged or needs a separate input/session implementation.
3. Exercise Default to Winlogon to Default transitions during a short recording,
   including fresh frames, missing-frame annotation and continuous timestamps.
4. Verify wrong user/session/connection, stale authorization and unrelated
   elevation requests are refused. Test cancellation/disconnect/emergency stop.
5. Only then add the capability to the local MCP and document installation,
   privileges, operator authorization, recovery and removal.

No privileged broker, session-token manipulation, service registration or UAC
policy change was performed as part of the system-audio implementation.
