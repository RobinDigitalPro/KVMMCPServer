// MIT. One bounded encoded-sample history; never opens a microphone or a file
// while buffering. Export muxes the already encoded samples without re-encoding.
#pragma once
#include <deque>
#include <mutex>
#include <atomic>
#include <array>
#include <codecapi.h>
#include <mferror.h>
#include <mftransform.h>

struct BufferProfile { const char* name; UINT width, fps, bitrate; };
static BufferProfile RecentProfile(const std::string& name) {
    if(name=="light")return {"light",640,5,1000000};
    if(name=="standard")return {"standard",1280,10,2000000};
    if(name=="high")return {"high",1920,15,4000000};
    throw std::runtime_error("invalid_buffer_profile");
}
struct EncodedPacket { bool video=false,clean=false; LONGLONG time=0,duration=0; DWORD flags=0; std::vector<BYTE> bytes; };
struct RecentSnapshot { std::vector<EncodedPacket> packets; std::array<ComPtr<IMFMediaType>,2> types; LONGLONG begin=0,end=0; size_t bytes=0; bool video=false,audio=false; };
class EncodedHistory {
    mutable std::mutex gate;
    std::deque<EncodedPacket> packets;
    std::array<ComPtr<IMFMediaType>,2> types;
    size_t bytes=0;
    LONGLONG lastVideo=0,lastAudio=0;
public:
    static constexpr size_t MaximumBytes=32*1024*1024,MaximumPacket=4*1024*1024,MaximumPackets=4096;
    static constexpr LONGLONG Window=30LL*10000000;
    bool video=false,audio=false;
    std::string error;
    EncodedHistory(bool v,bool a):video(v),audio(a){}
    void SetType(bool v,IMFMediaType* type){
        ComPtr<IMFMediaType> copy;Check(MFCreateMediaType(&copy),"copy encoded type");Check(type->CopyAllItems(copy.Get()),"copy encoded attributes");
        std::lock_guard<std::mutex> lock(gate);types[v?0:1]=copy;
    }
    HRESULT Push(bool v,IMFSample* sample) noexcept {
        try {
            EncodedPacket packet;packet.video=v;
            Check(sample->GetSampleTime(&packet.time),"encoded sample time");Check(sample->GetSampleDuration(&packet.duration),"encoded sample duration");
            if(packet.time<0||packet.duration<=0||packet.duration>10000000)throw std::runtime_error("invalid_encoded_timeline");
            sample->GetSampleFlags(&packet.flags);UINT32 clean=0;sample->GetUINT32(MFSampleExtension_CleanPoint,&clean);packet.clean=!v||clean!=0;
            ComPtr<IMFMediaBuffer> buffer;Check(sample->ConvertToContiguousBuffer(&buffer),"encoded sample buffer");
            DWORD count=0;Check(buffer->GetCurrentLength(&count),"encoded sample size");
            if(!count||count>MaximumPacket)throw std::runtime_error("encoded_packet_limit");
            BYTE* data=nullptr;Check(buffer->Lock(&data,nullptr,nullptr),"lock encoded sample");
            try{packet.bytes.assign(data,data+count);}catch(...){buffer->Unlock();throw;}buffer->Unlock();
            std::lock_guard<std::mutex> lock(gate);
            if(!error.empty())return E_FAIL;
            if(v)lastVideo=std::max(lastVideo,packet.time+packet.duration);else lastAudio=std::max(lastAudio,packet.time+packet.duration);
            bytes+=packet.bytes.size();packets.push_back(std::move(packet));
            const LONGLONG oldest=std::max(lastVideo,lastAudio)-Window;
            for(auto at=packets.begin();at!=packets.end();)if(at->time+at->duration<=oldest){bytes-=at->bytes.size();at=packets.erase(at);}else ++at;
            while(!packets.empty()&&(bytes>MaximumBytes||packets.size()>MaximumPackets)){
                bytes-=packets.front().bytes.size();packets.pop_front();
            }
            return S_OK;
        }catch(const std::exception& failure){std::lock_guard<std::mutex> lock(gate);error=failure.what();return E_FAIL;}
        catch(...){std::lock_guard<std::mutex> lock(gate);error="encoded_history_failure";return E_FAIL;}
    }
    RecentSnapshot Snapshot(double seconds,bool copy=true)const {
        std::lock_guard<std::mutex> lock(gate);RecentSnapshot result;result.video=video;result.audio=audio;result.types=types;
        result.end=video&&audio?std::min(lastVideo,lastAudio):std::max(lastVideo,lastAudio);
        const LONGLONG wanted=std::max<LONGLONG>(0,result.end-static_cast<LONGLONG>(seconds*10000000));
        bool found=false;
        for(const auto& packet:packets)if(packet.time>=wanted&&packet.time<result.end&&(!video||packet.video&&packet.clean)){
            result.begin=packet.time;found=true;break;
        }
        if(!found){result.begin=result.end;return result;}
        for(const auto& packet:packets)if(packet.time>=result.begin&&packet.time+packet.duration<=result.end){
            result.bytes+=packet.bytes.size();if(copy)result.packets.push_back(packet);
        }
        if(copy)std::stable_sort(result.packets.begin(),result.packets.end(),[](const EncodedPacket& a,const EncodedPacket& b){return a.time<b.time;});
        return result;
    }
    size_t Bytes()const{std::lock_guard<std::mutex> lock(gate);return bytes;}
    std::string Error()const{std::lock_guard<std::mutex> lock(gate);return error;}
};

// Synchronous, rate-less sinks receive the encoder output directly. They do not
// schedule playback or queue raw frames. Media Foundation supplies the codecs.
class RecentSink;
class RecentStream final : public IMFStreamSink, public IMFMediaTypeHandler {
    std::atomic<ULONG> references{1};
    std::mutex gate;
    ComPtr<IMFMediaSink> parent;
    ComPtr<IMFMediaEventQueue> events;
    ComPtr<IMFMediaType> type;
    std::shared_ptr<EncodedHistory> history;
    DWORD identifier;bool video,closed=false;
public:
    RecentStream(IMFMediaSink* owner,DWORD id,IMFMediaType* format,std::shared_ptr<EncodedHistory> store,bool v):parent(owner),type(format),history(std::move(store)),identifier(id),video(v){Check(MFCreateEventQueue(&events),"recent stream events");history->SetType(video,type.Get());}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid,void** value)override{
        if(!value)return E_POINTER;*value=nullptr;
        if(iid==__uuidof(IUnknown)||iid==__uuidof(IMFStreamSink)||iid==__uuidof(IMFMediaEventGenerator))*value=static_cast<IMFStreamSink*>(this);
        else if(iid==__uuidof(IMFMediaTypeHandler))*value=static_cast<IMFMediaTypeHandler*>(this);else return E_NOINTERFACE;
        AddRef();return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef()override{return ++references;}
    ULONG STDMETHODCALLTYPE Release()override{ULONG n=--references;if(!n)delete this;return n;}
    HRESULT STDMETHODCALLTYPE GetEvent(DWORD flags,IMFMediaEvent** event)override{return events->GetEvent(flags,event);}
    HRESULT STDMETHODCALLTYPE BeginGetEvent(IMFAsyncCallback* callback,IUnknown* state)override{return events->BeginGetEvent(callback,state);}
    HRESULT STDMETHODCALLTYPE EndGetEvent(IMFAsyncResult* result,IMFMediaEvent** event)override{return events->EndGetEvent(result,event);}
    HRESULT STDMETHODCALLTYPE QueueEvent(MediaEventType event,REFGUID extended,HRESULT status,const PROPVARIANT* value)override{return events->QueueEventParamVar(event,extended,status,value);}
    HRESULT STDMETHODCALLTYPE GetMediaSink(IMFMediaSink** value)override{std::lock_guard<std::mutex> lock(gate);if(closed)return MF_E_SHUTDOWN;return parent.CopyTo(value);}
    HRESULT STDMETHODCALLTYPE GetIdentifier(DWORD* value)override{if(!value)return E_POINTER;*value=identifier;return S_OK;}
    HRESULT STDMETHODCALLTYPE GetMediaTypeHandler(IMFMediaTypeHandler** value)override{if(!value)return E_POINTER;*value=this;AddRef();return S_OK;}
    HRESULT STDMETHODCALLTYPE ProcessSample(IMFSample* sample)override{std::lock_guard<std::mutex> lock(gate);if(closed)return MF_E_SHUTDOWN;const HRESULT hr=history->Push(video,sample);if(SUCCEEDED(hr))events->QueueEventParamVar(MEStreamSinkRequestSample,GUID_NULL,S_OK,nullptr);return hr;}
    HRESULT STDMETHODCALLTYPE PlaceMarker(MFSTREAMSINK_MARKER_TYPE,const PROPVARIANT*,const PROPVARIANT* context)override{return events->QueueEventParamVar(MEStreamSinkMarker,GUID_NULL,S_OK,context);}
    HRESULT STDMETHODCALLTYPE Flush()override{return S_OK;}
    HRESULT STDMETHODCALLTYPE IsMediaTypeSupported(IMFMediaType* candidate,IMFMediaType** closest)override{
        if(closest)*closest=nullptr;if(!candidate)return E_POINTER;GUID major={},subtype={};candidate->GetGUID(MF_MT_MAJOR_TYPE,&major);candidate->GetGUID(MF_MT_SUBTYPE,&subtype);
        return major==(video?MFMediaType_Video:MFMediaType_Audio)&&subtype==(video?MFVideoFormat_H264:MFAudioFormat_AAC)?S_OK:MF_E_INVALIDMEDIATYPE;
    }
    HRESULT STDMETHODCALLTYPE GetMediaTypeCount(DWORD* value)override{if(!value)return E_POINTER;*value=1;return S_OK;}
    HRESULT STDMETHODCALLTYPE GetMediaTypeByIndex(DWORD index,IMFMediaType** value)override{if(index)return MF_E_NO_MORE_TYPES;return GetCurrentMediaType(value);}
    HRESULT STDMETHODCALLTYPE SetCurrentMediaType(IMFMediaType* candidate)override{
        HRESULT hr=IsMediaTypeSupported(candidate,nullptr);if(FAILED(hr))return hr;
        try{std::lock_guard<std::mutex> lock(gate);if(closed)return MF_E_SHUTDOWN;type=candidate;history->SetType(video,candidate);return S_OK;}catch(...){return E_FAIL;}
    }
    HRESULT STDMETHODCALLTYPE GetCurrentMediaType(IMFMediaType** value)override{std::lock_guard<std::mutex> lock(gate);if(closed)return MF_E_SHUTDOWN;return type.CopyTo(value);}
    HRESULT STDMETHODCALLTYPE GetMajorType(GUID* value)override{if(!value)return E_POINTER;*value=video?MFMediaType_Video:MFMediaType_Audio;return S_OK;}
    void Shutdown(){std::lock_guard<std::mutex> lock(gate);if(closed)return;closed=true;events->Shutdown();parent.Reset();}
    HRESULT Start(){HRESULT hr=events->QueueEventParamVar(MEStreamSinkStarted,GUID_NULL,S_OK,nullptr);return FAILED(hr)?hr:events->QueueEventParamVar(MEStreamSinkRequestSample,GUID_NULL,S_OK,nullptr);}
    HRESULT Event(MediaEventType event){return events->QueueEventParamVar(event,GUID_NULL,S_OK,nullptr);}
};
class RecentSink final : public IMFMediaSink, public IMFClockStateSink {
    std::atomic<ULONG> references{1};
    std::vector<ComPtr<RecentStream>> streams;
    ComPtr<IMFPresentationClock> clock;
    bool closed=false;
public:
    void Add(IMFMediaType* type,std::shared_ptr<EncodedHistory> history,bool video){ComPtr<RecentStream> stream;stream.Attach(new RecentStream(this,static_cast<DWORD>(streams.size()),type,std::move(history),video));streams.push_back(stream);}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid,void** value)override{if(!value)return E_POINTER;*value=nullptr;if(iid==__uuidof(IUnknown)||iid==__uuidof(IMFMediaSink))*value=static_cast<IMFMediaSink*>(this);else if(iid==__uuidof(IMFClockStateSink))*value=static_cast<IMFClockStateSink*>(this);else return E_NOINTERFACE;AddRef();return S_OK;}
    ULONG STDMETHODCALLTYPE AddRef()override{return ++references;}
    ULONG STDMETHODCALLTYPE Release()override{ULONG n=--references;if(!n)delete this;return n;}
    HRESULT STDMETHODCALLTYPE GetCharacteristics(DWORD* value)override{if(!value)return E_POINTER;*value=MEDIASINK_FIXED_STREAMS|MEDIASINK_RATELESS;return S_OK;}
    HRESULT STDMETHODCALLTYPE AddStreamSink(DWORD,IMFMediaType*,IMFStreamSink**)override{return MF_E_STREAMSINKS_FIXED;}
    HRESULT STDMETHODCALLTYPE RemoveStreamSink(DWORD)override{return MF_E_STREAMSINKS_FIXED;}
    HRESULT STDMETHODCALLTYPE GetStreamSinkCount(DWORD* value)override{if(!value)return E_POINTER;*value=static_cast<DWORD>(streams.size());return S_OK;}
    HRESULT STDMETHODCALLTYPE GetStreamSinkByIndex(DWORD index,IMFStreamSink** value)override{if(closed)return MF_E_SHUTDOWN;if(index>=streams.size())return MF_E_INVALIDINDEX;return streams[index].CopyTo(value);}
    HRESULT STDMETHODCALLTYPE GetStreamSinkById(DWORD id,IMFStreamSink** value)override{return GetStreamSinkByIndex(id,value);}
    HRESULT STDMETHODCALLTYPE SetPresentationClock(IMFPresentationClock* value)override{if(clock)clock->RemoveClockStateSink(this);clock=value;return clock?clock->AddClockStateSink(this):S_OK;}
    HRESULT STDMETHODCALLTYPE GetPresentationClock(IMFPresentationClock** value)override{if(!clock)return MF_E_NO_CLOCK;return clock.CopyTo(value);}
    HRESULT STDMETHODCALLTYPE OnClockStart(MFTIME,LONGLONG)override{for(auto& stream:streams)stream->Start();return S_OK;}
    HRESULT STDMETHODCALLTYPE OnClockStop(MFTIME)override{for(auto& stream:streams)stream->Event(MEStreamSinkStopped);return S_OK;}
    HRESULT STDMETHODCALLTYPE OnClockPause(MFTIME)override{for(auto& stream:streams)stream->Event(MEStreamSinkPaused);return S_OK;}
    HRESULT STDMETHODCALLTYPE OnClockRestart(MFTIME time)override{return OnClockStart(time,0);}
    HRESULT STDMETHODCALLTYPE OnClockSetRate(MFTIME,float)override{return S_OK;}
    HRESULT STDMETHODCALLTYPE Shutdown()override{if(closed)return MF_E_SHUTDOWN;closed=true;if(clock)clock->RemoveClockStateSink(this);for(auto& stream:streams)stream->Shutdown();streams.clear();clock.Reset();return S_OK;}
};

class RecentMedia {
    ComPtr<IMFSinkWriter> writer;
    ComPtr<RecentSink> sink;
    std::unique_ptr<SystemAudio> source;
    DWORD videoStream=0,audioStream=0;
    UINT64 audioFrames=0;
    LONGLONG beganQpc=0;
    static ComPtr<IMFMediaType> AudioType(bool encoded){
        ComPtr<IMFMediaType> type;Check(MFCreateMediaType(&type),"audio type");
        Check(type->SetGUID(MF_MT_MAJOR_TYPE,MFMediaType_Audio),"audio major type");Check(type->SetGUID(MF_MT_SUBTYPE,encoded?MFAudioFormat_AAC:MFAudioFormat_PCM),"audio subtype");
        Check(type->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS,SystemAudio::Channels),"audio channels");Check(type->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND,SystemAudio::Rate),"audio rate");Check(type->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE,16),"audio depth");
        Check(type->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND,encoded?20000:SystemAudio::Rate*SystemAudio::Block),"audio bitrate");
        if(encoded)Check(type->SetUINT32(MF_MT_AAC_PAYLOAD_TYPE,0),"AAC payload");else Check(type->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT,SystemAudio::Block),"audio alignment");return type;
    }
    static ComPtr<IMFMediaType> VideoType(bool encoded,UINT width,UINT height,const BufferProfile& profile){
        ComPtr<IMFMediaType> type;Check(MFCreateMediaType(&type),"video type");
        Check(type->SetGUID(MF_MT_MAJOR_TYPE,MFMediaType_Video),"video major type");Check(type->SetGUID(MF_MT_SUBTYPE,encoded?MFVideoFormat_H264:MFVideoFormat_RGB32),"video subtype");
        Check(type->SetUINT32(MF_MT_INTERLACE_MODE,MFVideoInterlace_Progressive),"video interlace");Check(MFSetAttributeSize(type.Get(),MF_MT_FRAME_SIZE,width,height),"video size");Check(MFSetAttributeRatio(type.Get(),MF_MT_FRAME_RATE,profile.fps,1),"video FPS");Check(MFSetAttributeRatio(type.Get(),MF_MT_PIXEL_ASPECT_RATIO,1,1),"video pixels");
        if(encoded){Check(type->SetUINT32(MF_MT_AVG_BITRATE,profile.bitrate),"video bitrate");Check(type->SetUINT32(MF_MT_MPEG2_PROFILE,66),"baseline profile");}
        else Check(type->SetUINT32(MF_MT_DEFAULT_STRIDE,width*4),"video stride");return type;
    }
    void AudioSample(const BYTE* data,UINT count){
        if(!count)return;
        ComPtr<IMFMediaBuffer> buffer;Check(MFCreateMemoryBuffer(count*SystemAudio::Block,&buffer),"PCM buffer");BYTE* bytes=nullptr;Check(buffer->Lock(&bytes,nullptr,nullptr),"PCM lock");
        if(data)memcpy(bytes,data,count*SystemAudio::Block);else memset(bytes,0,count*SystemAudio::Block);buffer->Unlock();Check(buffer->SetCurrentLength(count*SystemAudio::Block),"PCM length");
        ComPtr<IMFSample> sample;Check(MFCreateSample(&sample),"PCM sample");Check(sample->AddBuffer(buffer.Get()),"PCM sample buffer");
        const LONGLONG begin=static_cast<LONGLONG>(audioFrames*10000000/SystemAudio::Rate),end=static_cast<LONGLONG>((audioFrames+count)*10000000/SystemAudio::Rate);
        Check(sample->SetSampleTime(begin),"PCM time");Check(sample->SetSampleDuration(end-begin),"PCM duration");Check(writer->WriteSample(audioStream,sample.Get()),"encode history audio");audioFrames+=count;
    }
    void SilenceUntil(UINT64 target){
        if(target>audioFrames+SystemAudio::Rate*2)throw std::runtime_error("audio_backlog");
        while(audioFrames<target)AudioSample(nullptr,static_cast<UINT>(std::min<UINT64>(target-audioFrames,4800)));
    }
    void RefreshTypes(){
        ComPtr<IMFSinkWriterEx> extra;if(FAILED(writer.As(&extra)))return;
        for(const bool video:{true,false}){
            if(video?!hasVideo:!hasAudio)continue;
            const DWORD stream=video?videoStream:audioStream;
            for(DWORD index=0;index<8;index++){
                GUID category={};ComPtr<IMFTransform> transform;if(FAILED(extra->GetTransformForStream(stream,index,&category,&transform)))break;
                ComPtr<IMFMediaType> type;if(FAILED(transform->GetOutputCurrentType(0,&type)))continue;GUID subtype={};type->GetGUID(MF_MT_SUBTYPE,&subtype);
                if(subtype==(video?MFVideoFormat_H264:MFAudioFormat_AAC))history->SetType(video,type.Get());
            }
        }
    }
public:
    std::shared_ptr<EncodedHistory> history;
    std::string id,mode,state="idle",reason,startedUtc,stoppedUtc;
    BufferProfile profile={"standard",1280,10,2000000};
    bool hasVideo=false,hasAudio=false;
    UINT width=0,height=0,sourceWidth=0,sourceHeight=0;
    UINT64 frames=0,droppedFrames=0;
    Clock::time_point began,next;
    explicit RecentMedia(std::unique_ptr<SystemAudio> audio=std::make_unique<SystemAudio>()):source(std::move(audio)){}
    ~RecentMedia(){try{Stop("worker_shutdown");}catch(...){}if(sink)sink->Shutdown();}
    bool Active()const{return writer!=nullptr&&state=="buffering";}
    void Begin(const std::string& identity,const std::string& requestedMode,const std::string& requestedProfile,const Frame& first){
        if(Active())throw std::runtime_error("buffer_already_active");Identifier(identity);profile=RecentProfile(requestedProfile);
        if(requestedMode!="audio"&&requestedMode!="video"&&requestedMode!="combined")throw std::runtime_error("invalid_buffer_mode");
        mode=requestedMode;id=identity;hasVideo=mode!="audio";hasAudio=mode!="video";
        width=hasVideo?first.width:0;height=hasVideo?first.height:0;
        if(hasVideo&&(!width||!height||width>profile.width||height>profile.width*9/16||first.pixels.size()!=static_cast<size_t>(width)*height*4))throw std::runtime_error("buffer_video_dimensions");
        if(hasAudio&&!source->Initialize())throw std::runtime_error("audio_unavailable: "+source->error);
        history=std::make_shared<EncodedHistory>(hasVideo,hasAudio);sink.Attach(new RecentSink());
        if(hasVideo){videoStream=0;const auto type=VideoType(true,width,height,profile);sink->Add(type.Get(),history,true);}
        if(hasAudio){audioStream=hasVideo?1:0;const auto type=AudioType(true);sink->Add(type.Get(),history,false);}
        try{
            ComPtr<IMFAttributes> attributes;Check(MFCreateAttributes(&attributes,3),"history encoder attributes");Check(attributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,TRUE),"history hardware preference");Check(attributes->SetUINT32(MF_LOW_LATENCY,TRUE),"history low latency");
            Check(MFCreateSinkWriterFromMediaSink(sink.Get(),attributes.Get(),&writer),"history encoder writer");
            if(hasVideo){const auto input=VideoType(false,width,height,profile);Check(writer->SetInputMediaType(videoStream,input.Get(),nullptr),"history RGB input");}
            if(hasAudio){const auto input=AudioType(false);Check(writer->SetInputMediaType(audioStream,input.Get(),nullptr),"history PCM input");}
            if(hasVideo){
                ComPtr<IMFSinkWriterEncoderConfig> config;Check(writer.As(&config),"history encoder config");ComPtr<IMFAttributes> parameters;Check(MFCreateAttributes(&parameters,2),"history GOP parameters");Check(parameters->SetUINT32(CODECAPI_AVEncMPVGOPSize,profile.fps),"history GOP size");Check(parameters->SetUINT32(CODECAPI_AVEncMPVDefaultBPictureCount,0),"history no B frames");Check(config->PlaceEncodingParameters(videoStream,parameters.Get()),"history bounded GOP");
            }
            Check(writer->BeginWriting(),"begin history encoding");RefreshTypes();
            audioFrames=0;frames=0;droppedFrames=0;began=Clock::now();beganQpc=Qpc100ns();next=began+std::chrono::microseconds(1000000/profile.fps);startedUtc=Utc();stoppedUtc.clear();reason.clear();state="buffering";
            if(hasAudio)source->Start();if(hasVideo)WriteVideo(first,0);
        }catch(...){source->Close();writer.Reset();sink->Shutdown();sink.Reset();state="failed";reason="encoder_start_failed";throw;}
    }
    void WriteVideo(const Frame& frame,LONGLONG time){
        if(!Active()||!hasVideo)return;if(frame.width!=width||frame.height!=height)throw std::runtime_error("display_changed");
        ComPtr<IMFMediaBuffer> buffer;const DWORD size=static_cast<DWORD>(frame.pixels.size());Check(MFCreateMemoryBuffer(size,&buffer),"history video buffer");BYTE* data=nullptr;Check(buffer->Lock(&data,nullptr,nullptr),"history pixels lock");memcpy(data,frame.pixels.data(),size);buffer->Unlock();Check(buffer->SetCurrentLength(size),"history video size");
        ComPtr<IMFSample> sample;Check(MFCreateSample(&sample),"history video sample");Check(sample->AddBuffer(buffer.Get()),"history frame buffer");Check(sample->SetSampleTime(time),"history frame time");Check(sample->SetSampleDuration(10000000/profile.fps),"history frame duration");Check(writer->WriteSample(videoStream,sample.Get()),"encode history video");frames++;RefreshTypes();
    }
    void PumpAudio(bool final=false){
        if(!Active()||!hasAudio)return;
        const LONGLONG elapsed=std::max<LONGLONG>(0,Qpc100ns()-beganQpc);
        const UINT64 target=static_cast<UINT64>(elapsed)*SystemAudio::Rate/10000000;
        source->Drain([&](const BYTE* data,UINT count,DWORD flags,UINT64 qpc){
            if(count>SystemAudio::Rate)throw std::runtime_error("audio_packet_limit");
            const LONGLONG packetStart=(flags&AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR)?static_cast<LONGLONG>(target)-count:(static_cast<LONGLONG>(qpc)-beganQpc)*SystemAudio::Rate/10000000;
            UINT skip=packetStart<0?static_cast<UINT>(std::min<LONGLONG>(-packetStart,count)):0;
            const LONGLONG position=packetStart+skip;
            if(position<static_cast<LONGLONG>(audioFrames))skip+=static_cast<UINT>(std::min<UINT64>(audioFrames-static_cast<UINT64>(std::max<LONGLONG>(0,position)),count-skip));
            if(skip>=count)return;
            const UINT64 safePosition=static_cast<UINT64>(std::max<LONGLONG>(0,packetStart+skip));
            if(safePosition>=target)return;SilenceUntil(safePosition);
            const UINT take=static_cast<UINT>(std::min<UINT64>(count-skip,target-audioFrames));
            AudioSample(!data||(flags&AUDCLNT_BUFFERFLAGS_SILENT)?nullptr:data+static_cast<size_t>(skip)*SystemAudio::Block,take);
        });
        SilenceUntil(final?target:target>4800?target-4800:0);
    }
    LONGLONG Elapsed()const{return std::chrono::duration_cast<std::chrono::microseconds>(Clock::now()-began).count()*10;}
    void Stop(const std::string& why){
        if(!writer)return;
        try{PumpAudio(true);}catch(const std::exception& failure){reason=failure.what();}
        source->Close();HRESULT hr=writer->Finalize();RefreshTypes();writer.Reset();sink->Shutdown();sink.Reset();
        state=FAILED(hr)?"failed":"stopped";if(reason.empty())reason=FAILED(hr)?"encoder_finalize_failed":why;stoppedUtc=Utc();
    }
    std::string Status()const{
        RecentSnapshot snapshot;if(history)snapshot=history->Snapshot(30,false);
        std::ostringstream out;out<<"\"bufferId\":"<<Json(id)<<",\"mode\":"<<Json(mode)<<",\"profile\":"<<Json(profile.name)<<",\"state\":"<<Json(state)<<",\"reason\":"<<Json(reason)<<",\"startedUtc\":"<<Json(startedUtc)<<",\"stoppedUtc\":"<<Json(stoppedUtc)<<",\"availableSeconds\":"<<static_cast<double>(snapshot.end-snapshot.begin)/10000000<<",\"bufferedBytes\":"<<(history?history->Bytes():0)<<",\"maxBytes\":"<<EncodedHistory::MaximumBytes<<",\"maxSeconds\":30,\"width\":"<<width<<",\"height\":"<<height<<",\"fps\":"<<(hasVideo?profile.fps:0)<<",\"videoBitrate\":"<<(hasVideo?profile.bitrate:0)<<",\"audioBitrate\":"<<(hasAudio?160000:0)<<",\"sampleRate\":"<<(hasAudio?SystemAudio::Rate:0)<<",\"channels\":"<<(hasAudio?SystemAudio::Channels:0)<<",\"microphone\":false,\"frames\":"<<frames<<",\"droppedFrames\":"<<droppedFrames;return out.str();
    }
    static void Export(const RecentSnapshot& snapshot,const fs::path& output,const std::atomic<bool>* cancelled=nullptr){
        if(snapshot.packets.empty()||snapshot.end<=snapshot.begin)throw std::runtime_error("buffer_not_ready");
        ComPtr<IMFAttributes> attributes;Check(MFCreateAttributes(&attributes,2),"export attributes");Check(attributes->SetGUID(MF_TRANSCODE_CONTAINERTYPE,MFTranscodeContainerType_MPEG4),"export MP4 container");Check(attributes->SetUINT32(MF_READWRITE_DISABLE_CONVERTERS,TRUE),"export passthrough");
        ComPtr<IMFSinkWriter> exportWriter;Check(MFCreateSinkWriterFromURL(output.c_str(),nullptr,attributes.Get(),&exportWriter),"history export writer");std::array<DWORD,2> streams={MAXDWORD,MAXDWORD};
        for(size_t index=0;index<2;index++)if(snapshot.types[index]&&(index==0?snapshot.video:snapshot.audio)){Check(exportWriter->AddStream(snapshot.types[index].Get(),&streams[index]),"export encoded stream");Check(exportWriter->SetInputMediaType(streams[index],snapshot.types[index].Get(),nullptr),"export compressed input");}
        Check(exportWriter->BeginWriting(),"begin history mux");
        for(const auto& packet:snapshot.packets){
            if(cancelled&&*cancelled)throw std::runtime_error("export_cancelled");
            const DWORD stream=streams[packet.video?0:1];if(stream==MAXDWORD)throw std::runtime_error("missing_encoded_media_type");
            ComPtr<IMFMediaBuffer> buffer;Check(MFCreateMemoryBuffer(static_cast<DWORD>(packet.bytes.size()),&buffer),"export packet");BYTE* bytes=nullptr;Check(buffer->Lock(&bytes,nullptr,nullptr),"export packet lock");memcpy(bytes,packet.bytes.data(),packet.bytes.size());buffer->Unlock();Check(buffer->SetCurrentLength(static_cast<DWORD>(packet.bytes.size())),"export packet size");
            ComPtr<IMFSample> sample;Check(MFCreateSample(&sample),"export sample");Check(sample->AddBuffer(buffer.Get()),"export buffer");Check(sample->SetSampleTime(packet.time-snapshot.begin),"export timestamp");Check(sample->SetSampleDuration(packet.duration),"export duration");Check(sample->SetSampleFlags(packet.flags),"export flags");if(packet.clean)Check(sample->SetUINT32(MFSampleExtension_CleanPoint,TRUE),"export keyframe");Check(exportWriter->WriteSample(stream,sample.Get()),"mux history sample");
        }
        Check(exportWriter->Finalize(),"finalize history export");
    }
};
