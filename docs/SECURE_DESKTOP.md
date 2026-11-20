# Optional secure desktop / UAC support

Service policy: **0.8.0**; compatible with controller/MCP **0.7.1**. The local
operator requested removal of the original per-program consent allowlist.
Physical-console testing verified a real MCP `hid_click` on Yes for an unstaged
harmless probe, its elevated exit code 0, and refusal of a click outside a
recognized button. Application registration is no longer required.

Earlier 0.5.0 tests on Windows 11 build 26100 verified real UAC capture, details
expansion, expired-frame and wrong-owner rejection, and MCP stop.
A 90-second MP4 containing Default/UAC/Default transitions and system audio
decoded completely. The first service installation needs manual Windows UAC
approval; the extension cannot bootstrap its own rights.

## Installation

Normal MCP adapters, the shared controller, HID helper, recorder and WASAPI audio
remain ordinary user processes. The optional `KVMMCPServerSecureDesktop` service
runs as SYSTEM from `C:\Program Files\KVMMCPServer\SecureDesktop`. Its own fixed
helper runs in the active physical console session. Cross-session communication
uses a separate SYSTEM-only private named pipe, not inherited handles. A job
kills the helper when the service stops and prevents child-process creation.

Build to an external directory:

```powershell
.\scripts\Build-Native.ps1 -OutputDirectory D:\AgentData\uac-build
.\scripts\Build-Capture.ps1 -EwdkRoot E:\ -OutputDirectory D:\AgentData\uac-build
.\scripts\Build-SecureDesktop.ps1 -OutputDirectory D:\AgentData\uac-build
$hashes = @{}
foreach ($name in 'SecureDesktopBroker.exe','UacProbe.exe') {
    $hashes[$name] = (Get-FileHash -LiteralPath (Join-Path D:\AgentData\uac-build $name)).Hash
}
@{version='0.8.0';hashes=$hashes} | ConvertTo-Json |
    Set-Content -LiteralPath D:\AgentData\uac-build\secure-package.json -Encoding UTF8
```

Review the sources and exact package hashes. Stop the normal controller before
installation. From an administrator PowerShell run the following, supplying the
SID of the Windows account that actually runs the local MCP (obtain it with
`whoami /user` before elevation if elevation uses a different account):

```powershell
.\scripts\Install-SecureDesktop.ps1 -BuildDirectory D:\AgentData\uac-build `
    -OperatorSid S-1-5-21-EXAMPLE-ACCOUNT-SID
```

The installer pins copied executable hashes, restricts directory/file ownership
and permissions to administrators/SYSTEM with operator read/execute, creates a
noninteractive automatic service and starts it. No UAC policy, desktop ACL,
certificate trust or third-party driver setting is changed. Installation fails
if a service/target folder already exists; it never silently replaces a live
privileged binary. For a reviewed service update, stop every HID controller and
run `scripts/Update-SecureDesktop.ps1` as administrator with `-BuildDirectory`,
`-ExpectedInstalledSha256`, `-PackageManifestSha256` and
`-ConfirmControllerStopped`. It pins both the existing binary and package,
backs up the protected executable/receipt and restores them if activation fails.
Existing application metadata, the probe, service registration and Windows UAC
policy remain. Application metadata is diagnostic, not an approval filter.

For the initial extension deploy compatible `HidTransport.exe`, `ScreenCapture.exe`
and user-mode source. A service-only 0.8.0 update works with controller 0.7.1.
Restart the normal controller after service installation or
restart. A service identity change causes control to stop, requiring the normal
explicit local resume. `hid_status.native.secureDesktopSupported` must be true
before claiming the UAC route is available. Ordinary desktop use still works
without the optional service.

## Existing agent workflow

Consent uses the existing capture/mouse tools; 0.7.1 has seventeen tools in total,
including ordinary-desktop keyboard/text conveniences and an atomic click. Acquire a short lease and inspect a fresh
`hid_capture` image. On a real Windows consent dialog it reports
`desktop="Winlogon"` and a short-lived `uacPromptId`; this is internally forwarded
to the input helper. The normal HID writer pauses, neutralizes its state and
hands off its session mutex. The service may then send a bounded one-shot VHF
mouse action. Default-desktop input resumes after the prompt closes.

For UAC, move with either mouse collection, but use an **absolute left click**
for an identified consent button. `Show more details` may be operated so the
executable location is visible. Take a new screenshot after expanding it. A
click on Yes approves the identified consent prompt without a separate
executable path/hash check. Check the displayed program and requested operation
against the user's authorization before approving. No/Cancel can dismiss an
identified prompt. A click on
another control, right click, wheel, keyboard entry, credentials, unrelated secure
desktop or stale prompt is refused. No denied input is
silently retried as ordinary desktop input.

Approval sends a complete click and neutralization. The caller's subsequent
mouse-up is harmless even if the prompt already closed. Take a fresh ordinary
desktop screenshot before the next action. Owner disconnect/cancellation stops
an in-flight privileged input process; the service checks caller PID/start time,
active session, prompt identity and both elapsed/UTC deadlines immediately
before input. Unknown write outcomes fault control. A pre-input policy refusal
preserves the lease so the caller can inspect a fresh frame.

The first frame from a newly created normal DXGI duplicator can still be black.
A secure-desktop transition can also show only the background while the dialog
repaints. Inspect a subsequent fresh usable frame. Never use a black, blank or
old frame as proof of the consent dialog or of a successful click.

## Local operator consent

The harmless protected `UacProbe.exe` is included for testing. It has an
administrator manifest, checks whether its token is elevated, exits with code
0 on success and changes no host configuration. The service does not launch it
or any requested program; ordinary Windows elevation must already be pending.

There is no program registration step in 0.8.0. Installers, PowerShell and other
programs can receive consent through the same recognized Yes button. This gives
the authorized local agent the ability to confirm Windows administrator
elevation; users should grant it only to agents they trust with that capability.
The service does not judge a command's intent or automatically approve prompts.
It only performs the explicit, short-lived consent action requested by the
registered local controller. The MCP remains local; remote job clients receive
no HID or direct UAC tool.

`Register-SecureDesktopApplication.ps1` is retained for legacy installations and
optional protected-copy metadata. It does not grant or restrict consent under
0.8.0. Existing `applications` configuration is accepted as diagnostic metadata.
Other UI languages/profiles, multi-monitor consent dialogs and credential
prompts need separate validation; unidentified controls remain refused.

The Windows 11 consent profile also recognizes the actual `ExpandedTextLine`
location text and the `ShowHideDetails` hyperlink. It requires the location
prefix when reporting executable locations; locations are informational.
Prompt GUIDs compare by value, including screenshots emitted in uppercase.

## Recordings and operator stop

MP4 encoding and system playback audio remain under the ordinary user. During
UAC, fresh SYSTEM/GDI pixel buffers replace the DXGI image source; the service
writes no screenshots or recordings. Output stays in the configured data root.
Short transition gaps are black placeholder frames, never cached Default/UAC
images. Unavailable capture beyond the bounded grace interrupts/finalizes the
recording. Receipts report `secureDesktopFrames`, `transitionFrames` and
`desktopTransitions`. The native 600-second cap remains.

The SYSTEM helper observes Ctrl+Alt+F12 on the secure desktop and signals the
registered normal HID controller through a restricted event. That controller
persists the existing operator stop and stops recordings. The independent kernel
watchdog remains enabled. Input grants also expire and are invalidated by the
operator stop epoch. Normal MCP tools cannot clear the stop.

## Inspection, audit and removal

```powershell
Get-Service KVMMCPServerSecureDesktop
& 'C:\Program Files\KVMMCPServer\SecureDesktop\SecureDesktopBroker.exe' status
Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='KVMMCPServerSecureDesktop'}
```

The named pipe rejects remote connections and authenticates the configured
Windows SID and active physical-console session. Its PID must match the running
SCM service. Only one registered normal HID controller can submit secure input.
The public service API has no arbitrary shell, process launch, registry, general
file write or credential entry endpoint. Native controller action logs remain
in the configured runtime data root; consent actions also reach Windows Event
Log. Only administrator-controlled setup scripts replace the protected service.

Stop the ordinary controller, then remove the optional service as administrator:

```powershell
.\scripts\Remove-SecureDesktop.ps1 -ConfirmControllerStopped
```

The script retains protected files for review and leaves recordings, VHF input
driver and optional third-party display/audio drivers untouched.

## Validation on another host

1. Read-only SYSTEM helper status and a visually verified real consent screenshot.
2. Denial of an off-button click, stale prompt and wrong input owner.
3. One unstaged, harmless probe click, with its elevated exit code checked.
4. Recording Default -> UAC -> Default, decoded video/audio and transition counts.
5. Owner disconnect/cancel, local operator stop and clean restoration of normal
   desktop control. Do not claim acceptance based on compiler/unit tests alone.

The physical Ctrl+Alt+F12 chord while on UAC has not been manually verified on
the development host; the MCP emergency stop was verified there. Credential
dialogs, other Windows UI profiles/languages and multi-monitor consent dialogs
are not accepted by this host test. Unsupported identities/actions fail closed.
