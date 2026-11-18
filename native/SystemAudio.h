// MIT. Render-endpoint loopback only; never opens a microphone/capture endpoint.
#pragma once
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functional>

static LONGLONG Qpc100ns() {
    LARGE_INTEGER counter, frequency; QueryPerformanceCounter(&counter); QueryPerformanceFrequency(&frequency);
    return (counter.QuadPart / frequency.QuadPart) * 10000000 + (counter.QuadPart % frequency.QuadPart) * 10000000 / frequency.QuadPart;
}

class SystemAudio {
    ComPtr<IMMDeviceEnumerator> enumerator;
    ComPtr<IMMDevice> endpoint;
    ComPtr<IAudioClient> client;
    ComPtr<IAudioCaptureClient> capture;
    bool started = false;
public:
    static constexpr UINT Rate = 48000, Channels = 2, Block = 4;
    std::string error;
    virtual ~SystemAudio() { Close(); }
    virtual const char* Source() const { return "default_render_loopback"; }
    virtual void Close() {
        if (started && client) client->Stop();
        started = false; capture.Reset(); client.Reset(); endpoint.Reset(); enumerator.Reset();
    }
    virtual bool Initialize() {
        Close(); error.clear();
        try {
            Check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)), "audio device enumerator");
            Check(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &endpoint), "default system audio output");
            Check(endpoint->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &client), "system audio client");
            WAVEFORMATEX format = {}; format.wFormatTag = WAVE_FORMAT_PCM; format.nChannels = Channels; format.nSamplesPerSec = Rate; format.wBitsPerSample = 16; format.nBlockAlign = Block; format.nAvgBytesPerSec = Rate * Block;
            Check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 10000000, 0, &format, nullptr), "system audio loopback");
            Check(client->GetService(IID_PPV_ARGS(&capture)), "loopback capture service");
            return true;
        } catch (const std::exception& exception) { error = exception.what(); Close(); return false; }
    }
    virtual void Start() { Check(client->Start(), "start system audio loopback"); started = true; }
    virtual void Drain(const std::function<void(const BYTE*, UINT, DWORD, UINT64)>& consume) {
        if (!started) return;
        for (unsigned int packets = 0; packets < 100; ++packets) {
            UINT available = 0; Check(capture->GetNextPacketSize(&available), "system audio packet"); if (!available) return;
            BYTE* data = nullptr; UINT frames = 0; DWORD flags = 0; UINT64 position = 0, qpc = 0;
            Check(capture->GetBuffer(&data, &frames, &flags, &position, &qpc), "read system audio");
            try { consume(data, frames, flags, qpc); }
            catch (...) { capture->ReleaseBuffer(frames); throw; }
            Check(capture->ReleaseBuffer(frames), "release system audio packet");
        }
    }
};
