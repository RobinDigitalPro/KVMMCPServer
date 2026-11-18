#include <ntddk.h>
#include <wdf.h>
#include <vhf.h>
#include "report_contract.h"
#include "descriptors.h"

typedef struct _ODH_CONTEXT {
    VHFHANDLE Vhf;
    KSPIN_LOCK Lock;
    WDFTIMER Watchdog;
    ULONGLONG LastInput;
    UCHAR Relative[5];
    UCHAR Absolute[7];
    UCHAR Keyboard[9];
    BOOLEAN RelativeHeld, AbsoluteHeld, KeyboardHeld;
} ODH_CONTEXT, *PODH_CONTEXT;
WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(ODH_CONTEXT, OdhGetContext);

DRIVER_INITIALIZE DriverEntry;
EVT_WDF_DRIVER_DEVICE_ADD OdhDeviceAdd;
EVT_WDF_OBJECT_CONTEXT_CLEANUP OdhCleanup;
EVT_WDF_TIMER OdhWatchdog;
EVT_WDF_DEVICE_D0_ENTRY OdhD0Entry;
EVT_WDF_DEVICE_D0_EXIT OdhD0Exit;
EVT_VHF_ASYNC_OPERATION OdhWriteReport;

static NTSTATUS OdhSubmit(PODH_CONTEXT context, PUCHAR report, ULONG size)
{
    HID_XFER_PACKET packet;
    RtlZeroMemory(&packet, sizeof(packet));
    packet.reportId = report[0];
    packet.reportBuffer = report;
    packet.reportBufferLen = size;
    /* Default VHF buffering copies the report before this call returns. */
    return VhfReadReportSubmit(context->Vhf, &packet);
}

/* Caller holds Lock. Retry unsuccessful neutral reports at the next tick. */
static VOID OdhRelease(PODH_CONTEXT context)
{
    if (context->RelativeHeld) {
        RtlZeroMemory(context->Relative, sizeof(context->Relative));
        context->Relative[0] = 4;
        if (NT_SUCCESS(OdhSubmit(context, context->Relative, sizeof(context->Relative)))) context->RelativeHeld = FALSE;
    }
    if (context->AbsoluteHeld) {
        context->Absolute[1] = 0; context->Absolute[6] = 0;
        if (NT_SUCCESS(OdhSubmit(context, context->Absolute, sizeof(context->Absolute)))) context->AbsoluteHeld = FALSE;
    }
    if (context->KeyboardHeld) {
        RtlZeroMemory(context->Keyboard, sizeof(context->Keyboard));
        context->Keyboard[0] = 7;
        if (NT_SUCCESS(OdhSubmit(context, context->Keyboard, sizeof(context->Keyboard)))) context->KeyboardHeld = FALSE;
    }
}

VOID OdhWriteReport(PVOID client, VHFOPERATIONHANDLE operation, PVOID operationContext, PHID_XFER_PACKET packet)
{
    PODH_CONTEXT context = (PODH_CONTEXT)client;
    NTSTATUS status = STATUS_INVALID_PARAMETER;
    UCHAR report[9];
    ULONG length = 0, i;
    KIRQL oldIrql;
    BOOLEAN held = FALSE;
    UNREFERENCED_PARAMETER(operationContext);

    /* Validate the entire envelope before reading its nested length or payload. */
    if (packet && packet->reportId == 0x40 && packet->reportBuffer && packet->reportBufferLen == 65 && packet->reportBuffer[0] == 0x40) {
        length = packet->reportBuffer[1];
        if (length == 0) {
            KeAcquireSpinLock(&context->Lock, &oldIrql);
            context->LastInput = KeQueryInterruptTime();
            KeReleaseSpinLock(&context->Lock, oldIrql);
            VhfAsyncOperationComplete(operation, STATUS_SUCCESS);
            return;
        }
        if (length <= sizeof(report) && length > 0 && OdhValidateReport(packet->reportBuffer + 2, length)) {
            RtlCopyMemory(report, packet->reportBuffer + 2, length);
            KeAcquireSpinLock(&context->Lock, &oldIrql);
            status = OdhSubmit(context, report, length);
            if (NT_SUCCESS(status)) {
                context->LastInput = KeQueryInterruptTime();
                if (report[0] == 4) {
                    RtlCopyMemory(context->Relative, report, length);
                    context->RelativeHeld = report[1] != 0;
                } else if (report[0] == 3) {
                    RtlCopyMemory(context->Absolute, report, length);
                    context->AbsoluteHeld = report[1] != 0;
                } else {
                    RtlCopyMemory(context->Keyboard, report, length);
                    for (i = 1; i < length; i++) if (report[i]) held = TRUE;
                    context->KeyboardHeld = held;
                }
            }
            KeReleaseSpinLock(&context->Lock, oldIrql);
        }
    }
    VhfAsyncOperationComplete(operation, status);
}

VOID OdhWatchdog(WDFTIMER timer)
{
    PODH_CONTEXT context = OdhGetContext(WdfTimerGetParentObject(timer));
    KIRQL oldIrql;
    KeAcquireSpinLock(&context->Lock, &oldIrql);
    if (KeQueryInterruptTime() - context->LastInput >= 30000000ULL) OdhRelease(context);
    KeReleaseSpinLock(&context->Lock, oldIrql);
}

NTSTATUS OdhD0Entry(WDFDEVICE device, WDF_POWER_DEVICE_STATE previousState)
{
    PODH_CONTEXT context = OdhGetContext(device);
    UNREFERENCED_PARAMETER(previousState);
    WdfTimerStart(context->Watchdog, WDF_REL_TIMEOUT_IN_MS(100));
    return STATUS_SUCCESS;
}

NTSTATUS OdhD0Exit(WDFDEVICE device, WDF_POWER_DEVICE_STATE targetState)
{
    PODH_CONTEXT context = OdhGetContext(device);
    KIRQL oldIrql;
    UNREFERENCED_PARAMETER(targetState);
    WdfTimerStop(context->Watchdog, TRUE);
    KeAcquireSpinLock(&context->Lock, &oldIrql);
    OdhRelease(context);
    KeReleaseSpinLock(&context->Lock, oldIrql);
    return STATUS_SUCCESS;
}

VOID OdhCleanup(WDFOBJECT object)
{
    PODH_CONTEXT context = OdhGetContext(object);
    /* KMDF stops/destroys child timers before parent cleanup. The embedded
       kernel spin lock remains valid until synchronous VhfDelete returns. */
    if (context->Vhf) { VhfDelete(context->Vhf, TRUE); context->Vhf = NULL; }
}

NTSTATUS OdhDeviceAdd(WDFDRIVER driver, PWDFDEVICE_INIT init)
{
    WDF_OBJECT_ATTRIBUTES attributes;
    WDF_PNPPOWER_EVENT_CALLBACKS power;
    WDF_TIMER_CONFIG timer;
    WDFDEVICE device;
    PODH_CONTEXT context;
    VHF_CONFIG vhf;
    NTSTATUS status;
    UNREFERENCED_PARAMETER(driver);

    WDF_PNPPOWER_EVENT_CALLBACKS_INIT(&power);
    power.EvtDeviceD0Entry = OdhD0Entry;
    power.EvtDeviceD0Exit = OdhD0Exit;
    WdfDeviceInitSetPnpPowerEventCallbacks(init, &power);
    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, ODH_CONTEXT);
    attributes.EvtCleanupCallback = OdhCleanup;
    attributes.ExecutionLevel = WdfExecutionLevelPassive;
    status = WdfDeviceCreate(&init, &attributes, &device);
    if (!NT_SUCCESS(status)) return status;
    context = OdhGetContext(device);

    KeInitializeSpinLock(&context->Lock);

    WDF_TIMER_CONFIG_INIT_PERIODIC(&timer, OdhWatchdog, 100);
    timer.AutomaticSerialization = FALSE;
    WDF_OBJECT_ATTRIBUTES_INIT(&attributes);
    attributes.ParentObject = device;
    attributes.ExecutionLevel = WdfExecutionLevelDispatch;
    status = WdfTimerCreate(&timer, &attributes, &context->Watchdog);
    if (!NT_SUCCESS(status)) return status;

    VHF_CONFIG_INIT(&vhf, WdfDeviceWdmGetDeviceObject(device), sizeof(OdhReportDescriptor), OdhReportDescriptor);
    vhf.VhfClientContext = context;
    /* Local virtual prototype IDs, compatible with the vmulti transport. */
    vhf.VendorID = 0x00FF; vhf.ProductID = 0xBACC; vhf.VersionNumber = 0x0100;
    vhf.EvtVhfAsyncOperationWriteReport = OdhWriteReport;
    status = VhfCreate(&vhf, &context->Vhf);
    if (!NT_SUCCESS(status)) return status;
    return VhfStart(context->Vhf);
}

NTSTATUS DriverEntry(PDRIVER_OBJECT driverObject, PUNICODE_STRING registryPath)
{
    WDF_DRIVER_CONFIG config;
    WDF_DRIVER_CONFIG_INIT(&config, OdhDeviceAdd);
    return WdfDriverCreate(driverObject, registryPath, WDF_NO_OBJECT_ATTRIBUTES, &config, WDF_NO_HANDLE);
}
