# Prepare the physical host for development tests

The development package was installed on the original physical host on
17 November 2026 after approval of the exact certificate and package. Live
mouse/keyboard, watchdog and MCP screenshot tests passed in the local console
session. Deployment on a different host requires firmware access, administrator
rights and restarts. The installer does not change boot settings or start agents.

## Current host check

Run from the source directory:

```powershell
.\scripts\Get-HostReadiness.ps1 -AsJson
```

This reads the active kernel Code Integrity flags, rather than assuming a BCD
setting has already taken effect. The prepared host has Secure Boot off,
Test Mode active and HVCI enforcement off. HVCI was not changed by these scripts.
The controller uses a non-administrator token. Its current and active-console
session IDs must match for live operation.

## Firmware and Test Mode

1. Disable Secure Boot in this PC's UEFI settings and return to Windows. For an
   OS volume protected by BitLocker, arrange recovery access before changing
   firmware settings.
2. Open an **administrator** PowerShell window and run:

   ```powershell
   bcdedit.exe /set testsigning on
   ```

3. Restart Windows when ready. Check that `TestSigningActive` is true and
   `SecureBootEnabled` is false with the read-only script above.

Microsoft documents this development configuration in
[loading test-signed drivers](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/the-testsigning-boot-configuration-option).
Memory Integrity/HVCI is not changed by our scripts.

## Validate and install the exact package

Remount the EWDK ISO read-only after restarting if necessary. Get its current
drive letter; it is not guaranteed to remain the same across restarts.

Run the installer with the signed-package directory and the certificate
thumbprint and manifest SHA256 printed by the signing step. Check both against
the trusted local handoff, not just against files supplied with an unknown package.

```powershell
.\scripts\Install-Development.ps1 `
  -EwdkRoot E:\ `
  -PackageDirectory D:\AgentData\desktop-hid\driver\signed-0.1.0 `
  -ExpectedThumbprint YOUR_REVIEWED_CERTIFICATE_THUMBPRINT `
  -ExpectedManifestSha256 YOUR_REVIEWED_MANIFEST_SHA256 `
  -ValidateOnly
```

`-ValidateOnly` verifies file hashes, the pinned certificate, signer and DevCon,
then reports the host state. It makes no installation/trust changes. This mode
has passed locally, followed by successful approved installation.

In the administrator window, run the same command without `-ValidateOnly` only
after the host state is ready. The installer trusts only that certificate in
the machine Root/TrustedPublisher stores and installs `ROOT\OpenDesktopHID`.
It refuses an already registered OpenDesktopHID service instead of creating a
second root device. It reports whether another restart is required.

For this original workstation, the ignored `deployment.local.json` contains the
reviewed paths and pins. The shorter local commands remount the ISO if needed:

```powershell
.\scripts\Install-Local.ps1 -ValidateOnly
# After firmware/Test Mode preparation, in an administrator window:
.\scripts\Install-Local.ps1
```

Do not rerun installation on the installed host: its duplicate-service guard
intentionally refuses it. The local receipt reported success without a further
reboot requirement. This remains development code; see measured results and
remaining tests in [ACCEPTANCE.md](ACCEPTANCE.md).

## First live test

Probe the installed device using `HidTransport.exe probe`. Start the separately
built Input Observer with an output JSONL path in the operational data area.
Keep that window focused. Test relative movement first, then absolute movement,
buttons, wheel and keyboard, observing each result independently. Finally test
release, heartbeat loss and operator takeover before connecting ordinary agents.

Controller/MCP 0.3.0 uses the official SDK and allows several local stdio
adapters to share one physical-console controller. Register it explicitly using
scripts/Install-McpConnection.ps1 and follow [AGENT_USAGE.md](AGENT_USAGE.md).
The first live adapter can start the shared controller as the normal interactive
user. Normal input/capture does not need elevation. Stop the controller before
rebuilding/replacing its native executable. Operator stops persist across
restarts and require the explicit local management resume command.
RDP is a different session; the helper does not transfer sessions automatically.
Secure desktops remain out of scope.

## Restore the host after testing

Stop the agent/helper and release input, then remove only this virtual device:

```powershell
& 'E:\Program Files\Windows Kits\10\Tools\10.0.26100.0\x64\devcon.exe' remove 'ROOT\OpenDesktopHID'
```

Remove only the reviewed development certificate from machine Root and
TrustedPublisher stores when it is no longer needed. Disable Test Mode using
`bcdedit.exe /set testsigning off`, restart, and restore the desired Secure Boot
setting in UEFI. The signing key is non-exportable in the original user's
personal certificate store; it is never included in the repository or package.
