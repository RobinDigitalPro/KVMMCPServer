// MIT. Windows desktop duplication, WIC stills and Media Foundation MP4.
// User-mode only: no driver, injection, remote endpoint or microphone capture.
#define NOMINMAX
#include <windows.h>
#include <wtsapi32.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wincodec.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include <iomanip>
#include <cmath>
#include <mferror.h>
#include <mmsystem.h>
#include <memory>
#include <mutex>
#include <thread>
#include <atomic>

using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;
namespace fs = std::filesystem;
static constexpr int MaximumSeconds = 600;

static void Check(HRESULT value, const char* operation) {
    if (FAILED(value)) { std::ostringstream text; text << operation << " (0x" << std::hex << static_cast<unsigned long>(value) << ')'; throw std::runtime_error(text.str()); }
}
static std::string Utf8(const std::wstring& value) {
    const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string output(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), output.data(), size, nullptr, nullptr); return output;
}
static std::string Json(const std::string& value) {
    std::ostringstream out; out << '"';
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') out << '\\' << c;
        else if (c < 32) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c) << std::dec;
        else out << c;
    }
    out << '"'; return out.str();
}
static void Emit(const std::string& value) { static std::mutex gate;std::lock_guard<std::mutex> lock(gate);std::cout << value << std::endl; }
static std::string Utc() {
    SYSTEMTIME now; GetSystemTime(&now); char text[40];
    sprintf_s(text, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond, now.wMilliseconds); return text;
}
static std::wstring RequireConsole() {
    DWORD current = 0; ProcessIdToSessionId(GetCurrentProcessId(), &current);
    if (current != WTSGetActiveConsoleSessionId()) throw std::runtime_error("console_session_changed");
    HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
    // Secure-desktop ACLs can hide even its name from this ordinary process.
    // The SYSTEM broker must positively identify consent.exe before any pixels
    // are accepted; an inaccessible/locked desktop is never captured blindly.
    if (!desktop) return L"Winlogon";
    wchar_t name[256] = {}; DWORD length = 0;
    const BOOL ok = GetUserObjectInformationW(desktop, UOI_NAME, name, sizeof(name), &length); CloseDesktop(desktop);
    if (!ok || (_wcsicmp(name,L"Default")!=0 && _wcsicmp(name,L"Winlogon")!=0)) throw std::runtime_error("input_desktop_not_supported");
    return name;
}
static int Number(const std::string& text, int minimum, int maximum) {
    size_t used = 0; const int result = std::stoi(text, &used);
    if (used != text.size() || result < minimum || result > maximum) throw std::runtime_error("number_out_of_range"); return result;
}
static void Identifier(const std::string& value) {
    if (value.size() != 36 || value.find_first_not_of("0123456789abcdef-") != std::string::npos) throw std::runtime_error("invalid_identifier");
}
struct Frame { UINT width = 0, height = 0; std::vector<BYTE> pixels; POINT cursor = {}; bool cursorIncluded = false; std::string desktop="Default",uacPromptId; };
#include "SecureDesktopCapture.h"
#include "SystemAudio.h"
#include "../test/SyntheticSystemAudio.h"

class Capture {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDXGIOutputDuplication> duplication;
    ComPtr<ID3D11Texture2D> staging;
    Frame cached;
    bool separatePointer = true;
    std::wstring lastDesktop;
public:
    ComPtr<IWICImagingFactory> wic;
    Capture() { Check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&wic)), "WIC factory"); }
    void Reset() { duplication.Reset(); staging.Reset(); context.Reset(); device.Reset(); cached = {}; }
    void Initialize() {
        if(RequireConsole()!=L"Default")throw std::runtime_error("default_desktop_required_for_dxgi");
        // Select the primary monitor's adapter, including hybrid-GPU systems.
        ComPtr<IDXGIFactory1> factory; Check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "DXGI factory");
        for (UINT a = 0;; ++a) {
            ComPtr<IDXGIAdapter1> adapter;
            if (factory->EnumAdapters1(a, &adapter) == DXGI_ERROR_NOT_FOUND) break;
            for (UINT o = 0;; ++o) {
                ComPtr<IDXGIOutput> output;
                if (adapter->EnumOutputs(o, &output) == DXGI_ERROR_NOT_FOUND) break;
                DXGI_OUTPUT_DESC desc = {}; Check(output->GetDesc(&desc), "output description");
                if (!desc.AttachedToDesktop || desc.DesktopCoordinates.left != 0 || desc.DesktopCoordinates.top != 0) continue;
                MONITORINFO info = { sizeof(MONITORINFO) };
                if (!GetMonitorInfoW(desc.Monitor, &info) || !(info.dwFlags & MONITORINFOF_PRIMARY)) continue;
                Check(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &context), "D3D device");
                ComPtr<IDXGIOutput1> modern; Check(output.As(&modern), "DXGI output");
                Check(modern->DuplicateOutput(device.Get(), &duplication), "desktop duplication");
                return;
            }
        }
        throw std::runtime_error("primary_display_unavailable");
    }
    Frame Grab(bool cursor) {
        const std::wstring desktop=RequireConsole();
        if(desktop!=lastDesktop){Reset();lastDesktop=desktop;}
        if(desktop==L"Winlogon"){Frame frame=SecureDesktopFrame(cursor);if(RequireConsole()!=desktop)throw std::runtime_error("desktop_changed_during_secure_capture");return frame;}
        if (!duplication) Initialize();
        ComPtr<IDXGIResource> resource; DXGI_OUTDUPL_FRAME_INFO info = {};
        HRESULT hr = duplication->AcquireNextFrame(cached.pixels.empty() ? 1000 : 0, &info, &resource);
        if (hr == DXGI_ERROR_ACCESS_LOST) { Reset(); throw std::runtime_error("display_configuration_changed"); }
        if (hr != DXGI_ERROR_WAIT_TIMEOUT) {
            Check(hr, "acquire desktop frame");
            try {
                if (info.LastMouseUpdateTime.QuadPart != 0) separatePointer = info.PointerPosition.Visible != FALSE;
                ComPtr<ID3D11Texture2D> texture; Check(resource.As(&texture), "desktop texture");
                D3D11_TEXTURE2D_DESC desc; texture->GetDesc(&desc);
                if(!desc.Width||!desc.Height||static_cast<UINT64>(desc.Width)*desc.Height>33554432)throw std::runtime_error("source_display_pixel_limit");
                DXGI_OUTDUPL_DESC outputDesc; duplication->GetDesc(&outputDesc);
                if (outputDesc.Rotation != DXGI_MODE_ROTATION_IDENTITY && outputDesc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) throw std::runtime_error("rotated_display_not_supported");
                if (!staging || cached.width != desc.Width || cached.height != desc.Height) {
                    desc.BindFlags = 0; desc.MiscFlags = 0; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ; desc.Usage = D3D11_USAGE_STAGING;
                    staging.Reset(); Check(device->CreateTexture2D(&desc, nullptr, &staging), "staging texture");
                    cached.width = desc.Width; cached.height = desc.Height; cached.pixels.resize(static_cast<size_t>(desc.Width) * desc.Height * 4);
                }
                context->CopyResource(staging.Get(), texture.Get());
                D3D11_MAPPED_SUBRESOURCE mapped; Check(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "map desktop texture");
                for (UINT y = 0; y < cached.height; ++y) memcpy(cached.pixels.data() + static_cast<size_t>(y) * cached.width * 4, static_cast<const BYTE*>(mapped.pData) + static_cast<size_t>(y) * mapped.RowPitch, cached.width * 4);
                context->Unmap(staging.Get(), 0);
            } catch (...) { duplication->ReleaseFrame(); throw; }
            Check(duplication->ReleaseFrame(), "release desktop frame");
        }
        if(RequireConsole()!=desktop){Reset();throw std::runtime_error("desktop_changed_during_capture");}
        if (cached.pixels.empty()) throw std::runtime_error("desktop_frame_unavailable");
        Frame frame = cached; GetCursorPos(&frame.cursor);
        if (cursor && !separatePointer) frame.cursorIncluded = true;
        if (cursor && separatePointer) {
            CURSORINFO pointer = { sizeof(CURSORINFO) };
            // Desktop duplication may already include a hardware-composited pointer.
            if (GetCursorInfo(&pointer) && (pointer.flags & CURSOR_SHOWING)) {
                ICONINFO icon = {};
                if (GetIconInfo(pointer.hCursor, &icon)) {
                    BITMAPINFO bitmap = {}; bitmap.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); bitmap.bmiHeader.biWidth = frame.width; bitmap.bmiHeader.biHeight = -static_cast<LONG>(frame.height); bitmap.bmiHeader.biPlanes = 1; bitmap.bmiHeader.biBitCount = 32; bitmap.bmiHeader.biCompression = BI_RGB;
                    void* pixels = nullptr; HBITMAP dib = CreateDIBSection(nullptr, &bitmap, DIB_RGB_COLORS, &pixels, nullptr, 0); HDC dc = CreateCompatibleDC(nullptr);
                    if (dib && dc && pixels) { HGDIOBJ old = SelectObject(dc, dib); memcpy(pixels, frame.pixels.data(), frame.pixels.size()); DrawIconEx(dc, pointer.ptScreenPos.x - icon.xHotspot, pointer.ptScreenPos.y - icon.yHotspot, pointer.hCursor, 0, 0, 0, nullptr, DI_NORMAL); GdiFlush(); memcpy(frame.pixels.data(), pixels, frame.pixels.size()); SelectObject(dc, old); frame.cursorIncluded = true; }
                    if (dc) DeleteDC(dc); if (dib) DeleteObject(dib); if (icon.hbmMask) DeleteObject(icon.hbmMask); if (icon.hbmColor) DeleteObject(icon.hbmColor);
                }
            }
        }
        // GDI cursor drawing can clear alpha in the icon rectangle. Make the
        // desktop opaque before WIC scaling, otherwise the cursor scales black.
        for (size_t i = 3; i < frame.pixels.size(); i += 4) frame.pixels[i] = 255;
        return frame;
    }
    Frame Scale(const Frame& frame, UINT width, bool even) {
        Frame result = frame;
        result.width = width ? std::min(width, frame.width) : frame.width;
        result.height = static_cast<UINT>(static_cast<uint64_t>(frame.height) * result.width / frame.width);
        if (even) { result.width &= ~1U; result.height &= ~1U; }
        if (result.width < 2 || result.height < 2) throw std::runtime_error("invalid_frame_dimensions");
        if (result.width == frame.width && result.height == frame.height) return result;
        ComPtr<IWICBitmap> bitmap; Check(wic->CreateBitmapFromMemory(frame.width, frame.height, GUID_WICPixelFormat32bppBGRA, frame.width * 4, static_cast<UINT>(frame.pixels.size()), const_cast<BYTE*>(frame.pixels.data()), &bitmap), "scale source");
        ComPtr<IWICBitmapScaler> scaler; Check(wic->CreateBitmapScaler(&scaler), "image scaler"); Check(scaler->Initialize(bitmap.Get(), result.width, result.height, WICBitmapInterpolationModeFant), "scale frame");
        result.pixels.resize(static_cast<size_t>(result.width) * result.height * 4); Check(scaler->CopyPixels(nullptr, result.width * 4, static_cast<UINT>(result.pixels.size()), result.pixels.data()), "scaled pixels"); return result;
    }
    void Save(const Frame& frame, const fs::path& path, bool jpeg) {
        if (fs::exists(path)) throw std::runtime_error("output_already_exists");
        ComPtr<IWICStream> stream; Check(wic->CreateStream(&stream), "image stream"); Check(stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE), "image output");
        ComPtr<IWICBitmapEncoder> encoder; Check(wic->CreateEncoder(jpeg ? GUID_ContainerFormatJpeg : GUID_ContainerFormatPng, nullptr, &encoder), "image encoder"); Check(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache), "initialize image encoder");
        ComPtr<IWICBitmapFrameEncode> output; ComPtr<IPropertyBag2> properties; Check(encoder->CreateNewFrame(&output, &properties), "image frame");
        if (jpeg) { PROPBAG2 option = {}; option.pstrName = const_cast<wchar_t*>(L"ImageQuality"); VARIANT value; VariantInit(&value); value.vt = VT_R4; value.fltVal = 0.85f; Check(properties->Write(1, &option, &value), "JPEG quality"); }
        Check(output->Initialize(properties.Get()), "initialize image frame"); Check(output->SetSize(frame.width, frame.height), "image dimensions");
        WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR; Check(output->SetPixelFormat(&format), "image pixel format");
        ComPtr<IWICBitmap> bitmap; Check(wic->CreateBitmapFromMemory(frame.width, frame.height, GUID_WICPixelFormat32bppBGRA, frame.width * 4, static_cast<UINT>(frame.pixels.size()), const_cast<BYTE*>(frame.pixels.data()), &bitmap), "image bitmap");
        ComPtr<IWICFormatConverter> converter; Check(wic->CreateFormatConverter(&converter), "pixel converter"); Check(converter->Initialize(bitmap.Get(), format, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom), "convert pixels");
        Check(output->WriteSource(converter.Get(), nullptr), "write image"); Check(output->Commit(), "commit frame"); Check(encoder->Commit(), "commit image");
    }
};

class Recording {
    std::unique_ptr<SystemAudio> systemAudio;
    DWORD audioStream = 0;
    bool audioEnabled = false, audioRequested = true;
    std::string audioState, audioReason;
    UINT64 audioFrames = 0, audioCapturedFrames = 0;
    int audioPeak = 0;
    LONGLONG startQpc = 0;
    void AudioSample(const BYTE* data, UINT count) {
        if (!count) return;
        ComPtr<IMFMediaBuffer> buffer; Check(MFCreateMemoryBuffer(count * SystemAudio::Block, &buffer), "audio buffer");
        BYTE* output = nullptr; Check(buffer->Lock(&output, nullptr, nullptr), "lock audio buffer");
        if (data) memcpy(output, data, count * SystemAudio::Block); else memset(output, 0, count * SystemAudio::Block);
        Check(buffer->Unlock(), "unlock audio buffer"); Check(buffer->SetCurrentLength(count * SystemAudio::Block), "audio buffer length");
        ComPtr<IMFSample> sample; Check(MFCreateSample(&sample), "audio sample"); Check(sample->AddBuffer(buffer.Get()), "audio sample buffer");
        const LONGLONG begin = static_cast<LONGLONG>(audioFrames * 10000000 / SystemAudio::Rate), end = static_cast<LONGLONG>((audioFrames + count) * 10000000 / SystemAudio::Rate);
        Check(sample->SetSampleTime(begin), "audio timestamp"); Check(sample->SetSampleDuration(end - begin), "audio duration"); Check(writer->WriteSample(audioStream, sample.Get()), "encode system audio");
        audioFrames += count;
        if (data) {
            audioCapturedFrames += count;
            const SHORT* samples = reinterpret_cast<const SHORT*>(data);
            for (size_t i = 0; i < static_cast<size_t>(count) * SystemAudio::Channels; ++i) audioPeak = std::max(audioPeak, std::abs(static_cast<int>(samples[i])));
        }
    }
    void SilenceUntil(UINT64 target) {
        target = std::min<UINT64>(target, static_cast<UINT64>(seconds) * SystemAudio::Rate);
        while (audioFrames < target) AudioSample(nullptr, static_cast<UINT>(std::min<UINT64>(target - audioFrames, 4800)));
    }
    void ConfigureAudio() {
        ComPtr<IMFMediaType> output; Check(MFCreateMediaType(&output), "AAC output type");
        Check(output->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio), "audio output"); Check(output->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC), "AAC codec");
        Check(output->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, SystemAudio::Channels), "AAC channels"); Check(output->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, SystemAudio::Rate), "AAC rate");
        Check(output->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16), "AAC bits"); Check(output->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 20000), "AAC bitrate"); Check(output->SetUINT32(MF_MT_AAC_PAYLOAD_TYPE, 0), "AAC payload");
        Check(writer->AddStream(output.Get(), &audioStream), "add AAC stream");
        ComPtr<IMFMediaType> input; Check(MFCreateMediaType(&input), "PCM input type");
        Check(input->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio), "audio input"); Check(input->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM), "PCM codec");
        Check(input->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, SystemAudio::Channels), "PCM channels"); Check(input->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, SystemAudio::Rate), "PCM rate");
        Check(input->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16), "PCM bits"); Check(input->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, SystemAudio::Block), "PCM alignment"); Check(input->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, SystemAudio::Rate * SystemAudio::Block), "PCM byte rate");
        Check(writer->SetInputMediaType(audioStream, input.Get(), nullptr), "AAC input");
    }
public:
    explicit Recording(std::unique_ptr<SystemAudio> source = std::make_unique<SystemAudio>()) : systemAudio(std::move(source)) {}
    ComPtr<IMFSinkWriter> writer; DWORD stream = 0;
    std::string id, startedUtc; fs::path partial, final;
    Clock::time_point start, next; int seconds = 0, fps = 0, maxWidth = 0, bitrate = 0;
    UINT width = 0, height = 0, sourceWidth = 0, sourceHeight = 0; unsigned long frames = 0; LONGLONG mediaEnd = 0;
    unsigned long secureFrames=0,transitionFrames=0,desktopTransitions=0;std::string lastFrameDesktop;Clock::time_point transitionSince;
    bool active() const { return writer != nullptr; }
    void Begin(Capture& capture, const fs::path& root, const std::string& identity, int duration, int rate, int size, int bits, bool includeAudio = true) {
        if (active()) throw std::runtime_error("recording_already_active");
        Identifier(identity); if (duration < 1 || duration > MaximumSeconds) throw std::runtime_error("recording_limit_600_seconds");
        Frame source = capture.Grab(true), first = capture.Scale(source, size, true);
        id = identity; seconds = duration; fps = rate; maxWidth = size; bitrate = bits; width = first.width; height = first.height; sourceWidth = source.width; sourceHeight = source.height;
        frames = 0; mediaEnd = 0; audioFrames = 0; audioCapturedFrames = 0; audioPeak = 0; audioRequested = includeAudio;
        secureFrames=transitionFrames=desktopTransitions=0;lastFrameDesktop.clear();transitionSince={};
        audioEnabled = includeAudio && systemAudio->Initialize(); audioState = !includeAudio ? "disabled" : audioEnabled ? "capturing" : "unavailable"; audioReason = includeAudio ? systemAudio->error : "explicitly_disabled";
        partial = root / L"recordings" / fs::u8path(id + ".partial.mp4"); final = root / L"recordings" / fs::u8path(id + ".mp4");
        fs::create_directories(partial.parent_path()); if (fs::exists(partial) || fs::exists(final)) throw std::runtime_error("output_already_exists");
        ComPtr<IMFAttributes> attributes; Check(MFCreateAttributes(&attributes, 3), "encoder attributes");
        Check(attributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE), "hardware transforms");
        Check(attributes->SetUINT32(MF_SINK_WRITER_DISABLE_THROTTLING, TRUE), "encoder throttling");
        for (;;) {
          Check(MFCreateSinkWriterFromURL(partial.c_str(), nullptr, attributes.Get(), &writer), "MP4 sink writer");
          try {
            ComPtr<IMFMediaType> output; Check(MFCreateMediaType(&output), "output type");
            Check(output->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "output video"); Check(output->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264), "H264");
            Check(output->SetUINT32(MF_MT_AVG_BITRATE, bitrate), "bitrate"); Check(output->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "interlace");
            Check(MFSetAttributeSize(output.Get(), MF_MT_FRAME_SIZE, width, height), "output size"); Check(MFSetAttributeRatio(output.Get(), MF_MT_FRAME_RATE, fps, 1), "output rate"); Check(MFSetAttributeRatio(output.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1), "output aspect");
            Check(writer->AddStream(output.Get(), &stream), "add video stream");
            ComPtr<IMFMediaType> input; Check(MFCreateMediaType(&input), "input type"); Check(input->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "input video"); Check(input->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32), "RGB32");
            Check(input->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "input interlace"); Check(MFSetAttributeSize(input.Get(), MF_MT_FRAME_SIZE, width, height), "input size"); Check(MFSetAttributeRatio(input.Get(), MF_MT_FRAME_RATE, fps, 1), "input rate"); Check(MFSetAttributeRatio(input.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1), "input aspect");
            Check(input->SetUINT32(MF_MT_DEFAULT_STRIDE, width * 4), "input stride"); Check(writer->SetInputMediaType(stream, input.Get(), nullptr), "encoder input");
            if (audioEnabled) ConfigureAudio();
            Check(writer->BeginWriting(), "begin recording");
            first = capture.Scale(capture.Grab(true), maxWidth, true);
            start = Clock::now(); startQpc = Qpc100ns(); next = start; startedUtc = Utc();
            if (audioEnabled) { try { systemAudio->Start(); } catch (const std::exception& error) { audioState = "interrupted"; audioReason = error.what(); systemAudio->Close(); } }
            Write(first, 0); next += std::chrono::microseconds(1000000 / fps); break;
          } catch (const std::exception& error) {
            writer.Reset(); systemAudio->Close();
            if (!audioEnabled) throw;
            // Only our fresh UUID output can exist here. Retry video-only if
            // an endpoint/codec cannot be initialized; preserve an explicit reason.
            audioEnabled = false; audioState = "unavailable"; audioReason = error.what(); fs::remove(partial);
          }
        }
    }
    void PumpAudio(bool finalDrain = false) {
        if (!audioEnabled || !active()) return;
        const LONGLONG elapsed = std::clamp<LONGLONG>(Qpc100ns() - startQpc, 0, static_cast<LONGLONG>(seconds) * 10000000);
        const UINT64 limit = static_cast<UINT64>((finalDrain ? std::max(elapsed, mediaEnd) : elapsed) * SystemAudio::Rate / 10000000);
        try {
            systemAudio->Drain([&](const BYTE* data, UINT count, DWORD flags, UINT64 qpc) {
                const LONGLONG time = (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) ? Qpc100ns() - startQpc - static_cast<LONGLONG>(count) * 10000000 / SystemAudio::Rate : static_cast<LONGLONG>(qpc) - startQpc;
                LONGLONG at = time * SystemAudio::Rate / 10000000;
                UINT skip = at < 0 ? static_cast<UINT>(std::min<LONGLONG>(-at, count)) : 0;
                at += skip;
                if (at < static_cast<LONGLONG>(audioFrames)) skip += static_cast<UINT>(std::min<UINT64>(audioFrames - std::max<LONGLONG>(at, 0), count - skip));
                const UINT64 position = static_cast<UINT64>(std::max<LONGLONG>(time * SystemAudio::Rate / 10000000 + skip, 0));
                if (skip >= count || position >= limit) return;
                SilenceUntil(position);
                const UINT take = static_cast<UINT>(std::min<UINT64>(count - skip, limit - audioFrames));
                AudioSample((flags & AUDCLNT_BUFFERFLAGS_SILENT) || !data ? nullptr : data + static_cast<size_t>(skip) * SystemAudio::Block, take);
            });
        } catch (const std::exception& error) { audioState = "interrupted"; audioReason = error.what(); systemAudio->Close(); }
        // WASAPI may produce no packets during silence. Keep the AAC timeline
        // aligned, leaving 100 ms for delayed packets until the final drain.
        SilenceUntil(finalDrain ? limit : limit > 4800 ? limit - 4800 : 0);
    }
    void Write(const Frame& frame, LONGLONG timestamp) {
        if (frame.width != width || frame.height != height) throw std::runtime_error("display_dimensions_changed");
        if(frame.desktop=="Winlogon")++secureFrames;if(frame.desktop=="Transition")++transitionFrames;
        if(!lastFrameDesktop.empty()&&lastFrameDesktop!=frame.desktop)++desktopTransitions;lastFrameDesktop=frame.desktop;
        ComPtr<IMFMediaBuffer> buffer; const DWORD bytes = static_cast<DWORD>(frame.pixels.size()); Check(MFCreateMemoryBuffer(bytes, &buffer), "video buffer");
        BYTE* data = nullptr; Check(buffer->Lock(&data, nullptr, nullptr), "lock video buffer"); memcpy(data, frame.pixels.data(), bytes); Check(buffer->Unlock(), "unlock video buffer"); Check(buffer->SetCurrentLength(bytes), "video buffer length");
        ComPtr<IMFSample> sample; Check(MFCreateSample(&sample), "video sample"); Check(sample->AddBuffer(buffer.Get()), "sample buffer"); Check(sample->SetSampleTime(timestamp), "sample time");
        const LONGLONG duration = std::min<LONGLONG>(10000000 / fps, static_cast<LONGLONG>(seconds) * 10000000 - timestamp);
        if (duration <= 0) return;
        Check(sample->SetSampleDuration(duration), "sample duration"); Check(writer->WriteSample(stream, sample.Get()), "encode video sample"); mediaEnd = timestamp + duration; ++frames;
    }
    std::string Status(const char* state, const std::string& reason = "") const {
        std::ostringstream out; out << "\"recordingId\":" << Json(id) << ",\"state\":" << Json(state) << ",\"reason\":" << Json(reason) << ",\"startedUtc\":" << Json(startedUtc) << ",\"maxSeconds\":" << seconds << ",\"fps\":" << fps << ",\"width\":" << width << ",\"height\":" << height << ",\"frames\":" << frames << ",\"durationMs\":" << mediaEnd / 10000 << ",\"path\":" << Json(Utf8(final.wstring())) << ",\"partialPath\":" << Json(Utf8(partial.wstring())) << ",\"audio\":" << (audioEnabled ? "true" : "false") << ",\"systemAudioRequested\":" << (audioRequested ? "true" : "false") << ",\"audioSource\":" << Json(systemAudio->Source()) << ",\"audioStatus\":" << Json(audioState) << ",\"audioReason\":" << Json(audioReason) << ",\"audioSampleRate\":" << (audioEnabled ? SystemAudio::Rate : 0) << ",\"audioChannels\":" << (audioEnabled ? SystemAudio::Channels : 0) << ",\"audioFrames\":" << audioFrames << ",\"audioCapturedFrames\":" << audioCapturedFrames << ",\"audioPeak\":" << audioPeak << ",\"microphone\":false,\"cursorIncludedInImage\":true,\"secureDesktopFrames\":" << secureFrames << ",\"transitionFrames\":" << transitionFrames << ",\"desktopTransitions\":" << desktopTransitions; return out.str();
    }
    void Finish(const char* state, const std::string& reason) {
        if (!active()) return;
        try { PumpAudio(true); } catch (const std::exception& error) { audioState = "interrupted"; audioReason = error.what(); }
        systemAudio->Close();
        if (audioEnabled && audioState == "capturing") audioState = "captured";
        HRESULT hr = writer->Finalize(); writer.Reset();
        try { Check(hr, "finalize MP4"); fs::rename(partial, final); Emit("{\"type\":\"recording_finished\"," + Status(state, reason) + ",\"finishedUtc\":" + Json(Utc()) + ",\"finalized\":true}"); }
        catch (const std::exception& error) { Emit("{\"type\":\"recording_finished\"," + Status("failed", error.what()) + ",\"finishedUtc\":" + Json(Utc()) + ",\"finalized\":false}"); }
    }
    void Tick(Capture& capture) {
        RequireConsole();
        if (Clock::now() - start >= std::chrono::seconds(seconds)) { Finish("completed", "duration_limit"); return; }
        PumpAudio();
        if (Clock::now() >= next) {
            Frame source;
            try{source=capture.Grab(true);transitionSince={};}
            catch(const std::exception& error){const std::string reason=error.what();bool transient=reason=="secure_desktop_busy"||reason=="secure_desktop_capture_unavailable"||reason=="desktop_changed_during_secure_capture"||reason=="desktop_changed_during_capture"||reason=="display_configuration_changed"||reason=="desktop_frame_unavailable";
                if(!transient)throw;const auto now=Clock::now();if(transitionSince==Clock::time_point{})transitionSince=now;if(now-transitionSince>std::chrono::seconds(reason=="secure_desktop_busy"?5:1))throw;
                source.width=sourceWidth;source.height=sourceHeight;source.desktop="Transition";source.pixels.resize(static_cast<size_t>(sourceWidth)*sourceHeight*4,0);for(size_t i=3;i<source.pixels.size();i+=4)source.pixels[i]=255;
            }
            if (source.width != sourceWidth || source.height != sourceHeight) throw std::runtime_error("display_dimensions_changed");
            const LONGLONG time = std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - start).count() * 10;
            if (time < static_cast<LONGLONG>(seconds) * 10000000) Write(capture.Scale(source, maxWidth, true), time);
            const auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - start).count(); const auto interval = 1000000 / fps;
            next = start + std::chrono::microseconds((elapsed / interval + 1) * interval);
        }
    }
};

#include "RecentMedia.h"
#include "MediaGuard.h"

static Frame BufferFrame(Capture& capture,const Frame& source,const BufferProfile& profile){
    // Fit both dimensions, including portrait displays; never upscale.
    const UINT width=std::min(profile.width,static_cast<UINT>(static_cast<UINT64>(profile.width*9/16)*source.width/source.height));
    return capture.Scale(source,std::max<UINT>(2,width),true);
}
class RecentExport {
    std::thread worker;std::atomic<bool> busy{false},cancelled{false};
public:
    ~RecentExport(){cancelled=true;if(worker.joinable())worker.join();}
    bool Busy()const{return busy;}
    void Start(RecentSnapshot snapshot,const fs::path& root,const std::string& identity,const std::string& bufferId,int request){
        if(busy)throw std::runtime_error("export_busy");if(worker.joinable())worker.join();Identifier(identity);
        const fs::path folder=root/L"media";fs::create_directories(folder);const std::string extension=snapshot.video?".mp4":".m4a";
        const fs::path final=folder/fs::u8path(identity+extension),partial=folder/fs::u8path(identity+".partial"+extension);
        if(fs::exists(final)||fs::exists(partial))throw std::runtime_error("output_already_exists");
        if(snapshot.packets.empty())throw std::runtime_error("buffer_not_ready");busy=true;cancelled=false;
        try{worker=std::thread([this,snapshot=std::move(snapshot),partial,final,identity,bufferId,request](){
            const HRESULT initialized=CoInitializeEx(nullptr,COINIT_MULTITHREADED);
            try{
                Check(initialized,"export COM");RecentMedia::Export(snapshot,partial,&cancelled);
                if(cancelled)throw std::runtime_error("export_cancelled");fs::rename(partial,final);
                Emit("{\"id\":"+std::to_string(request)+",\"ok\":true,\"exportId\":"+Json(identity)+",\"bufferId\":"+Json(bufferId)+",\"path\":"+Json(final.u8string())+",\"mimeType\":"+Json(snapshot.video?"video/mp4":"audio/mp4")+",\"actualSeconds\":"+std::to_string(static_cast<double>(snapshot.end-snapshot.begin)/10000000)+",\"bytes\":"+std::to_string(fs::file_size(final))+",\"reencoded\":false,\"microphone\":false}");
            }catch(const std::exception& error){std::error_code ignored;fs::remove(partial,ignored);Emit("{\"id\":"+std::to_string(request)+",\"ok\":false,\"error\":"+Json(error.what())+"}");}
            if(SUCCEEDED(initialized))CoUninitialize();busy=false;
        });}catch(...){busy=false;throw;}
    }
    void Cancel(){cancelled=true;}
};

int wmain(int argc, wchar_t** argv) {
    if(argc==2&&std::wstring(argv[1])==L"self-test-history"){
        try{
            Check(CoInitializeEx(nullptr,COINIT_MULTITHREADED),"COM");Check(MFStartup(MF_VERSION),"Media Foundation");
            const auto packet=[](LONGLONG time,DWORD size){ComPtr<IMFSample> sample;Check(MFCreateSample(&sample),"test sample");ComPtr<IMFMediaBuffer> data;Check(MFCreateMemoryBuffer(size,&data),"test buffer");Check(data->SetCurrentLength(size),"test size");Check(sample->AddBuffer(data.Get()),"test payload");Check(sample->SetSampleTime(time),"test timestamp");Check(sample->SetSampleDuration(100000),"test duration");return sample;};
            EncodedHistory age(false,true);for(int n=0;n<40;n++)Check(age.Push(false,packet(static_cast<LONGLONG>(n)*10000000,4).Get()),"age insertion");
            const auto window=age.Snapshot(30);if(window.end-window.begin>EncodedHistory::Window||window.begin<90000000)throw std::runtime_error("age_eviction_failed");
            EncodedHistory bytes(false,true);for(int n=0;n<36;n++)Check(bytes.Push(false,packet(n*100000,1024*1024).Get()),"byte insertion");
            if(bytes.Bytes()>EncodedHistory::MaximumBytes||bytes.Bytes()!=32ULL*1024*1024)throw std::runtime_error("byte_eviction_failed");
            EncodedHistory bad(false,true);if(SUCCEEDED(bad.Push(false,packet(-1,1).Get())))throw std::runtime_error("timestamp_guard_failed");
            EncodedHistory large(false,true);if(SUCCEEDED(large.Push(false,packet(0,EncodedHistory::MaximumPacket+1).Get())))throw std::runtime_error("packet_guard_failed");
            if(MediaBudget::MemoryAdmitted(128ULL*1024*1024)||!MediaBudget::MemoryAdmitted(1024ULL*1024*1024))throw std::runtime_error("memory_admission_guard_failed");
            Emit("{\"ok\":true,\"checks\":5,\"inputSent\":false,\"captureOpened\":false,\"byteCap\":33554432,\"maxSeconds\":30}");return 0;
        }catch(const std::exception& error){Emit("{\"ok\":false,\"error\":"+Json(error.what())+"}");return 1;}
    }
    if(argc==7&&std::wstring(argv[1])==L"guarded-self-test-buffer"&&std::wstring(argv[2])==L"--data-root"){
        try{
            const std::wstring mode=argv[4],profile=argv[5];if(mode!=L"audio"&&mode!=L"video"&&mode!=L"combined")throw std::runtime_error("invalid_buffer_mode");RecentProfile(Utf8(profile));const int seconds=Number(Utf8(argv[6]),4,40);
            return GuardMediaWorker(fs::path(argv[3]),L" "+mode+L" "+profile+L" "+std::to_wstring(seconds));
        }catch(const std::exception& error){Emit("{\"ok\":false,\"error\":"+Json(error.what())+"}");return 1;}
    }
    if(argc==4&&std::wstring(argv[1])==L"guarded-serve"&&std::wstring(argv[2])==L"--data-root"){
        try{return GuardMediaWorker(fs::path(argv[3]));}catch(const std::exception& error){Emit("{\"type\":\"fatal\",\"error\":"+Json(error.what())+"}");return 1;}
    }
    if((argc==4||argc==6)&&std::wstring(argv[1])==L"self-test-buffer"){
        try{
            const fs::path root=argv[2];if(!root.is_absolute())throw std::runtime_error("absolute_test_root_required");fs::create_directories(root);
            Check(CoInitializeEx(nullptr,COINIT_MULTITHREADED),"COM");Check(MFStartup(MF_VERSION),"Media Foundation");
            const std::string mode=Utf8(argv[3]),profile=argc==6?Utf8(argv[4]):"light";const int seconds=argc==6?Number(Utf8(argv[5]),4,40):4;
            RecentMedia recent(std::make_unique<SyntheticSystemAudio>());MediaBudget budget;const auto settings=RecentProfile(profile);Frame first;first.width=settings.width;first.height=settings.width*9/16;first.pixels.resize(static_cast<size_t>(first.width)*first.height*4,128);
            recent.Begin("00000000-0000-4000-8000-000000000001",mode,profile,first);
            while(recent.Elapsed()<static_cast<LONGLONG>(seconds)*10000000){
                Sleep(5);budget.CheckUsage();recent.PumpAudio();
                if(mode!="audio"&&Clock::now()>=recent.next){for(size_t index=0;index<first.pixels.size();index+=4096)first.pixels[index]=static_cast<BYTE>(recent.frames%255);recent.WriteVideo(first,recent.Elapsed());recent.next=Clock::now()+std::chrono::microseconds(1000000/settings.fps);}
            }
            const auto live=recent.history->Snapshot(std::min(15,seconds));const fs::path liveOutput=root/(mode=="audio"?L"live.m4a":L"live.mp4");if(fs::exists(liveOutput))throw std::runtime_error("test_output_exists");RecentMedia::Export(live,liveOutput);
            recent.Stop("diagnostic_complete");
            for(const int duration:{5,15,30}){
                const auto snapshot=recent.history->Snapshot(duration);const fs::path output=root/fs::u8path(std::to_string(duration)+(mode=="audio"?".m4a":".mp4"));if(fs::exists(output))throw std::runtime_error("test_output_exists");RecentMedia::Export(snapshot,output);
                Emit("{\"ok\":true,\"synthetic\":true,\"inputSent\":false,\"requestedSeconds\":"+std::to_string(duration)+",\"actualSeconds\":"+std::to_string(static_cast<double>(snapshot.end-snapshot.begin)/10000000)+",\"exportPath\":"+Json(output.u8string())+",\"exportBytes\":"+std::to_string(fs::file_size(output))+","+recent.Status()+","+budget.Status()+"}");
            }
            return 0;
        }catch(const std::exception& error){Emit("{\"ok\":false,\"error\":"+Json(error.what())+"}");return 1;}
    }
    if (argc == 4 && std::wstring(argv[1]) == L"self-test-av") {
        try {
            if (!fs::path(argv[2]).is_absolute()) throw std::runtime_error("absolute_test_root_required");
            SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM"); Check(MFStartup(MF_VERSION), "Media Foundation");
            Capture capture; Recording recording(std::make_unique<SyntheticSystemAudio>());
            recording.Begin(capture, fs::path(argv[2]), Utf8(argv[3]), 3, 15, 1280, 6000000);
            while (recording.active()) { recording.Tick(capture); Sleep(5); }
            return 0;
        } catch (const std::exception& error) { Emit("{\"ok\":false,\"error\":" + Json(error.what()) + "}"); return 1; }
    }
    if (argc == 3 && std::wstring(argv[1]) == L"test-tone") {
        if (!fs::path(argv[2]).is_absolute()) return 2;
        if (!PlaySoundW(argv[2], nullptr, SND_FILENAME | SND_SYNC | SND_NODEFAULT)) return 1;
        Emit("{\"played\":true}"); return 0;
    }
    if (argc == 3 && std::wstring(argv[1]) == L"inspect-audio") {
        try {
            Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM"); Check(MFStartup(MF_VERSION), "Media Foundation");
            ComPtr<IMFSourceReader> reader; Check(MFCreateSourceReaderFromURL(argv[2], nullptr, &reader), "open recording audio");
            const DWORD audioStream = static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM);
            ComPtr<IMFMediaType> native; const HRESULT available = reader->GetNativeMediaType(audioStream, 0, &native);
            if (available == MF_E_INVALIDSTREAMNUMBER || available == MF_E_NO_MORE_TYPES) { Emit("{\"ok\":true,\"audio\":false}"); return 0; }
            Check(available, "read audio type");
            Check(reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE), "deselect streams"); Check(reader->SetStreamSelection(audioStream, TRUE), "select audio");
            ComPtr<IMFMediaType> pcm; Check(MFCreateMediaType(&pcm), "decoded audio type"); Check(pcm->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio), "decoded audio"); Check(pcm->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM), "decoded PCM"); Check(pcm->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16), "decoded bits");
            Check(reader->SetCurrentMediaType(audioStream, nullptr, pcm.Get()), "decode AAC to PCM"); Check(reader->GetCurrentMediaType(audioStream, &pcm), "decoded audio type");
            UINT32 rate = 0, channels = 0; Check(pcm->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &rate), "decoded audio rate"); Check(pcm->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &channels), "decoded audio channels");
            if (!rate || !channels || channels > 8) throw std::runtime_error("invalid_decoded_audio_format");
            UINT64 frames = 0, samples = 0; int peak = 0; double energy = 0; LONGLONG lastEnd = 0, firstSignal = -1, lastSignal = -1; DWORD flags = 0;
            for (unsigned int packet = 0; packet < 40000; ++packet) {
                ComPtr<IMFSample> sample; LONGLONG timestamp = 0; Check(reader->ReadSample(audioStream, 0, nullptr, &flags, &timestamp, &sample), "decode audio sample");
                if (sample) {
                    ComPtr<IMFMediaBuffer> buffer; Check(sample->ConvertToContiguousBuffer(&buffer), "decoded audio buffer"); BYTE* data = nullptr; DWORD bytes = 0; Check(buffer->Lock(&data, nullptr, &bytes), "decoded audio samples");
                    const SHORT* values = reinterpret_cast<const SHORT*>(data); const DWORD count = bytes / sizeof(SHORT);
                    for (DWORD n = 0; n < count; ++n) { const int level = std::abs(static_cast<int>(values[n])); peak = std::max(peak, level); energy += static_cast<double>(values[n]) * values[n]; if (level > 100) { const LONGLONG at = timestamp / 10000 + static_cast<LONGLONG>(n / channels) * 1000 / rate; if (firstSignal < 0) firstSignal = at; lastSignal = at; } }
                    buffer->Unlock(); samples += count; frames += count / channels; LONGLONG duration = 0; if (FAILED(sample->GetSampleDuration(&duration))) duration = static_cast<LONGLONG>(count / channels) * 10000000 / rate; lastEnd = std::max(lastEnd, timestamp + duration);
                }
                if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
            }
            if (!(flags & MF_SOURCE_READERF_ENDOFSTREAM)) throw std::runtime_error("audio_decode_limit_exceeded");
            std::ostringstream out; out << "{\"ok\":true,\"audio\":true,\"endOfStream\":true,\"sampleRate\":" << rate << ",\"channels\":" << channels << ",\"frames\":" << frames << ",\"durationMs\":" << lastEnd / 10000 << ",\"peak\":" << peak << ",\"rms\":" << (samples ? std::sqrt(energy / static_cast<double>(samples)) / 32768.0 : 0) << ",\"firstSignalMs\":" << firstSignal << ",\"lastSignalMs\":" << lastSignal << "}"; Emit(out.str()); return 0;
        } catch (const std::exception& error) { Emit("{\"ok\":false,\"error\":" + Json(error.what()) + "}"); return 1; }
    }
    if (argc == 2 && std::wstring(argv[1]) == L"audio-probe") {
        try { Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM"); SystemAudio audio; const bool available = audio.Initialize(); Emit("{\"available\":" + std::string(available ? "true" : "false") + ",\"source\":\"default_render_loopback\",\"microphone\":false,\"reason\":" + Json(audio.error) + "}"); return 0; }
        catch (const std::exception& error) { Emit("{\"available\":false,\"reason\":" + Json(error.what()) + "}"); return 1; }
    }
    if (argc == 4 && (std::wstring(argv[1]) == L"inspect" || std::wstring(argv[1]) == L"inspect-all")) {
        try {
            Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM"); Check(MFStartup(MF_VERSION), "Media Foundation");
            ComPtr<IMFAttributes> attributes; Check(MFCreateAttributes(&attributes, 1), "decoder attributes"); Check(attributes->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE), "decoder color conversion");
            ComPtr<IMFSourceReader> reader; Check(MFCreateSourceReaderFromURL(argv[2], attributes.Get(), &reader), "open recorded video");
            const DWORD videoStream = static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), mediaSource = static_cast<DWORD>(MF_SOURCE_READER_MEDIASOURCE);
            ComPtr<IMFMediaType> type; Check(MFCreateMediaType(&type), "decode type"); Check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "decode video"); Check(type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32), "decode RGB");
            Check(reader->SetCurrentMediaType(videoStream, nullptr, type.Get()), "decode format");
            Check(reader->GetCurrentMediaType(videoStream, &type), "decoded type"); UINT width, height; Check(MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &width, &height), "decoded dimensions");
            PROPVARIANT duration; PropVariantInit(&duration); Check(reader->GetPresentationAttribute(mediaSource, MF_PD_DURATION, &duration), "video duration");
            ComPtr<IMFSample> sample; DWORD flags = 0; LONGLONG timestamp = 0;
            for (int n = 0; n < 100 && !sample; ++n) { Check(reader->ReadSample(videoStream, 0, nullptr, &flags, &timestamp, &sample), "decode first frame"); if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break; }
            if (!sample) throw std::runtime_error("video_has_no_decodable_frame");
            ComPtr<IMFMediaBuffer> buffer; Check(sample->ConvertToContiguousBuffer(&buffer), "decoded buffer"); BYTE* data = nullptr; DWORD length = 0; Check(buffer->Lock(&data, nullptr, &length), "lock decoded pixels");
            Frame frame; frame.width = width; frame.height = height; frame.pixels.resize(static_cast<size_t>(width) * height * 4);
            if (length < frame.pixels.size()) { buffer->Unlock(); throw std::runtime_error("decoded_frame_too_small"); }
            memcpy(frame.pixels.data(), data, frame.pixels.size()); buffer->Unlock(); Capture capture; capture.Save(frame, fs::path(argv[3]), false);
            unsigned long decodedFrames = 1; LONGLONG lastTimestamp = timestamp;
            if (std::wstring(argv[1]) == L"inspect-all") {
                for (unsigned long count = 0; count < 20000; ++count) {
                    sample.Reset(); Check(reader->ReadSample(videoStream, 0, nullptr, &flags, &timestamp, &sample), "decode next frame");
                    if (sample) { ++decodedFrames; lastTimestamp = timestamp; }
                    if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
                }
                if (!(flags & MF_SOURCE_READERF_ENDOFSTREAM)) throw std::runtime_error("video_decode_frame_limit_exceeded");
            }
            Emit("{\"ok\":true,\"decoded\":true,\"width\":" + std::to_string(width) + ",\"height\":" + std::to_string(height) + ",\"durationMs\":" + std::to_string(duration.uhVal.QuadPart / 10000) + ",\"decodedFrames\":" + std::to_string(decodedFrames) + ",\"lastFrameMs\":" + std::to_string(lastTimestamp / 10000) + ",\"endOfStream\":" + ((flags & MF_SOURCE_READERF_ENDOFSTREAM) ? "true" : "false") + "}"); PropVariantClear(&duration); return 0;
        } catch (const std::exception& error) { Emit("{\"ok\":false,\"error\":" + Json(error.what()) + "}"); return 1; }
    }
    if (argc != 4 || std::wstring(argv[1]) != L"serve" || std::wstring(argv[2]) != L"--data-root") { std::cerr << "Usage: ScreenCapture.exe serve --data-root ABSOLUTE_DATA_ROOT\n"; return 2; }
    fs::path root = argv[3]; if (!root.is_absolute()) return 2;
    try {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM"); Check(MFStartup(MF_VERSION), "Media Foundation");
        Capture capture; Recording recording;std::unique_ptr<RecentMedia> recent;RecentExport exporter;MediaBudget budget;
        const auto bufferEvent=[&](const char* type){if(recent)Emit("{\"type\":"+Json(type)+","+recent->Status()+","+budget.Status()+"}");};
        const auto stopBuffer=[&](const std::string& reason){if(recent&&recent->Active()){recent->Stop(reason);bufferEvent("buffer_state");}};
        Emit("{\"type\":\"ready\",\"workerPid\":"+std::to_string(GetCurrentProcessId())+",\"backend\":\"dxgi-media-foundation\",\"maxRecordingSeconds\":600,\"systemAudioSupported\":true,\"bufferSupported\":true,\"protocolVersion\":3,"+budget.Status()+"}");
        HANDLE input = GetStdHandle(STD_INPUT_HANDLE); std::string pending; bool quitting = false; auto lastPing = Clock::now(), progress = lastPing;
        while (!quitting) {
            DWORD available = 0;
            if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) { recording.Finish("interrupted", "parent_disconnected");stopBuffer("agent_disconnected");exporter.Cancel(); break; }
            if (available) {
                char bytes[4096]; DWORD received = 0;
                if (!ReadFile(input, bytes, std::min<DWORD>(available, sizeof(bytes)), &received, nullptr) || !received) break;
                pending.append(bytes, received); if (pending.size() > 8192) throw std::runtime_error("command_too_large");
            }
            size_t newline;
            while ((newline = pending.find('\n')) != std::string::npos) {
                const std::string line = pending.substr(0, newline); pending.erase(0, newline + 1); std::istringstream in(line); std::vector<std::string> args; std::string part;
                while (std::getline(in, part, '\t')) args.push_back(part);
                int request = 0;
                try {
                    if (args.size() < 2) throw std::runtime_error("invalid_command"); request = Number(args[1], 1, 2147483647); const std::string op = args[0];
                    if (op == "ping" && args.size() == 2) { lastPing = Clock::now(); Emit("{\"id\":" + std::to_string(request) + ",\"ok\":true}"); continue; }
                    if (op == "quit" && args.size() == 2) { recording.Finish("interrupted", "controller_shutdown");stopBuffer("worker_shutdown");exporter.Cancel(); quitting = true; }
                    else if (op == "stop" && args.size() == 2) recording.Finish("stopped", "requested");
                    else if(op=="buffer_start"&&args.size()==5){
                        if(!MediaLimitsActive())throw std::runtime_error("media_resource_limits_required");
                        MediaBudget::Admit();
                        if(recording.active()||exporter.Busy())throw std::runtime_error("media_busy");
                        if(recent&&recent->Active())throw std::runtime_error("buffer_already_active");
                        Identifier(args[2]);const auto profile=RecentProfile(args[4]);if(args[3]!="audio"&&args[3]!="video"&&args[3]!="combined")throw std::runtime_error("invalid_buffer_mode");
                        if(RequireConsole()!=L"Default")throw std::runtime_error("default_desktop_required");
                        Frame first,source;if(args[3]!="audio"){source=capture.Grab(true);first=BufferFrame(capture,source,profile);}
                        recent=std::make_unique<RecentMedia>();recent->sourceWidth=source.width;recent->sourceHeight=source.height;
                        budget=MediaBudget();recent->Begin(args[2],args[3],args[4],first);bufferEvent("buffer_state");
                        Emit("{\"id\":"+std::to_string(request)+",\"ok\":true,"+recent->Status()+","+budget.Status()+"}");continue;
                    }else if(op=="buffer_status"&&args.size()==2){
                        Emit("{\"id\":"+std::to_string(request)+",\"ok\":true,"+(recent?recent->Status():"\"state\":\"idle\"")+","+budget.Status()+"}");continue;
                    }else if(op=="buffer_stop"&&args.size()==3){
                        if(args[2]!="requested"&&args[2]!="operator_stop"&&args[2]!="agent_disconnected"&&args[2]!="recording_started")throw std::runtime_error("invalid_stop_reason");
                        stopBuffer(args[2]);if(args[2]=="agent_disconnected"){exporter.Cancel();recent.reset();}
                        Emit("{\"id\":"+std::to_string(request)+",\"ok\":true,"+(recent?recent->Status():"\"state\":\"idle\"")+","+budget.Status()+"}");continue;
                    }else if(op=="buffer_export"&&args.size()==4){
                        if(recording.active()||exporter.Busy())throw std::runtime_error("media_busy");
                        if(!recent||!recent->history)throw std::runtime_error("buffer_not_ready");
                        const int seconds=Number(args[3],1,30);Identifier(args[2]);exporter.Start(recent->history->Snapshot(seconds),root,args[2],recent->id,request);continue;
                    }
                    else if (op == "record" && (args.size() == 7 || args.size() == 8)) {
                        Identifier(args[2]);const int duration=Number(args[3],1,MaximumSeconds),fps=Number(args[4],1,30),width=Number(args[5],0,3840),bits=Number(args[6],1000000,20000000);const bool audio=args.size()==7||Number(args[7],0,1)!=0;
                        RequireConsole();if(recording.active()||exporter.Busy())throw std::runtime_error("media_busy");stopBuffer("recording_started");budget=MediaBudget();
                        recording.Begin(capture, root, args[2],duration,fps,width,bits,audio);
                        Emit("{\"id\":" + std::to_string(request) + ",\"ok\":true," + recording.Status("recording") + "}"); continue;
                    } else if (op == "snapshot" && args.size() == 6) {
                        Identifier(args[2]); const bool jpeg = args[3] == "jpeg"; if (!jpeg && args[3] != "png") throw std::runtime_error("invalid_image_format");
                        Frame source = capture.Grab(Number(args[5], 0, 1) != 0); const std::string capturedUtc = Utc(); Frame frame = capture.Scale(source, Number(args[4], 0, 3840), false);
                        const fs::path output = root / L"captures" / fs::u8path(args[2] + (jpeg ? ".jpg" : ".png")); fs::create_directories(output.parent_path()); capture.Save(frame, output, jpeg); if(Utf8(RequireConsole())!=source.desktop)throw std::runtime_error("desktop_changed_during_snapshot");
                        DWORD session = 0; ProcessIdToSessionId(GetCurrentProcessId(), &session);
                        std::ostringstream out; out << "{\"id\":" << request << ",\"ok\":true,\"frameId\":" << Json(args[2]) << ",\"path\":" << Json(Utf8(output.wstring())) << ",\"capturedUtc\":" << Json(capturedUtc) << ",\"currentSession\":" << session << ",\"consoleSession\":" << WTSGetActiveConsoleSessionId() << ",\"display\":\"primary\",\"desktop\":" << Json(source.desktop) << ",\"uacPromptId\":" << Json(source.uacPromptId) << ",\"left\":0,\"top\":0,\"width\":" << frame.width << ",\"height\":" << frame.height << ",\"sourceWidth\":" << source.width << ",\"sourceHeight\":" << source.height << ",\"cursor\":{\"x\":" << source.cursor.x << ",\"y\":" << source.cursor.y << "},\"cursorIncludedInImage\":" << (frame.cursorIncluded ? "true" : "false") << ",\"mimeType\":" << Json(jpeg ? "image/jpeg" : "image/png") << ",\"inputSent\":false}"; Emit(out.str()); continue;
                    } else throw std::runtime_error("invalid_command");
                    Emit("{\"id\":" + std::to_string(request) + ",\"ok\":true}");
                } catch (const std::exception& error) { Emit("{\"id\":" + std::to_string(request) + ",\"ok\":false,\"error\":" + Json(error.what()) + "}"); }
            }
            if (recording.active()) {
                try {
                    RequireConsole();budget.CheckUsage(false); const auto now = Clock::now();
                    if (now - lastPing > std::chrono::seconds(5)) recording.Finish("interrupted", "controller_heartbeat_lost");
                    else recording.Tick(capture);
                    if (recording.active() && now - progress >= std::chrono::seconds(1)) { Emit("{\"type\":\"recording_progress\"," + recording.Status("recording") + "}"); progress = now; }
                } catch (const std::exception& error) { recording.Finish("interrupted", error.what()); capture.Reset(); }
            }
            if(recent&&recent->Active()){
                try{
                    const auto now=Clock::now();if(now-lastPing>std::chrono::seconds(5))throw std::runtime_error("controller_heartbeat_lost");
                    if(RequireConsole()!=L"Default")throw std::runtime_error("desktop_changed");budget.CheckUsage();recent->PumpAudio();
                    if(recent->hasVideo&&now>=recent->next){
                        Frame source=capture.Grab(true);if(source.desktop!="Default"||source.width!=recent->sourceWidth||source.height!=recent->sourceHeight)throw std::runtime_error("display_changed");
                        const auto interval=std::chrono::microseconds(1000000/recent->profile.fps);
                        if(now-recent->next>std::chrono::seconds(2))throw std::runtime_error("capture_backlog");
                        if(now-recent->next>interval*2)recent->droppedFrames++;
                        recent->WriteVideo(BufferFrame(capture,source,recent->profile),recent->Elapsed());recent->next=Clock::now()+interval;
                    }
                    if(!recent->history->Error().empty())throw std::runtime_error(recent->history->Error());
                    if(now-progress>=std::chrono::seconds(1)){bufferEvent("buffer_progress");progress=now;}
                }catch(const std::exception& error){stopBuffer(error.what());capture.Reset();}
            }
            Sleep(5);
        }
        recording.Finish("interrupted", "parent_disconnected");
        stopBuffer("worker_shutdown");exporter.Cancel();
        return 0;
    } catch (const std::exception& error) { Emit("{\"type\":\"fatal\",\"error\":" + Json(error.what()) + "}"); return 1; }
}
