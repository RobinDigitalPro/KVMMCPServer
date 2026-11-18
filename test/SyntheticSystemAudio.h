// MIT. Explicit diagnostic source; never selected by the MCP record command.
#pragma once
class SyntheticSystemAudio final : public SystemAudio {
    LONGLONG began = 0; UINT64 sent = 0; bool running = false;
public:
    const char* Source() const override { return "synthetic_test"; }
    bool Initialize() override { sent = 0; error.clear(); return true; }
    void Start() override { began = Qpc100ns(); running = true; }
    void Close() override { running = false; }
    void Drain(const std::function<void(const BYTE*, UINT, DWORD, UINT64)>& consume) override {
        if (!running) return;
        const UINT64 until = static_cast<UINT64>(std::max<LONGLONG>(Qpc100ns() - began, 0)) * Rate / 10000000;
        while (sent < until) {
            const UINT count = static_cast<UINT>(std::min<UINT64>(until - sent, 480)); std::vector<SHORT> samples(count * Channels);
            for (UINT n = 0; n < count; ++n) {
                const double seconds = static_cast<double>(sent + n) / Rate;
                const SHORT value = seconds >= 0.5 && seconds < 2.0 ? static_cast<SHORT>(3000.0 * std::sin(seconds * 440.0 * 6.283185307179586)) : 0;
                samples[n * Channels] = value; samples[n * Channels + 1] = value;
            }
            consume(reinterpret_cast<const BYTE*>(samples.data()), count, 0, static_cast<UINT64>(began) + sent * 10000000 / Rate); sent += count;
        }
    }
};
