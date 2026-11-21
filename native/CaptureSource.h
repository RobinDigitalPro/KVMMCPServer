// MIT. Strict source selection and direct window capture. No input injection.
#pragma once
#include <dwmapi.h>
#include <windows.graphics.capture.interop.h>
#include <Windows.Graphics.DirectX.Direct3D11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

static std::wstring Wide(const std::string& text){
    int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0);
    if(!n)throw std::runtime_error("invalid_utf8");std::wstring value(n,L'\0');
    MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),value.data(),n);return value;
}
struct CaptureSelection {
    std::string key="fullscreen",mode="fullscreen",area="client";std::wstring title;DWORD pid=0;
    UINT x=0,y=0,width=0,height=0;
    static CaptureSelection Parse(const std::string& text){
        CaptureSelection s;s.key=text;if(text=="fullscreen")return s;
        std::istringstream stream(text);std::vector<std::string> v;std::string part;
        while(std::getline(stream,part,':'))v.push_back(part);
        if(v.size()==5&&v[0]=="region"){
            s.mode="region";s.x=Number(v[1],0,32767);s.y=Number(v[2],0,32767);s.width=Number(v[3],2,32768);s.height=Number(v[4],2,32768);return s;
        }
        if(v.size()==4&&v[0]=="window"&&(v[2]=="client"||v[2]=="window")){
            size_t used=0;unsigned long long pid=std::stoull(v[1],&used);if(used!=v[1].size()||pid>MAXDWORD)throw std::runtime_error("invalid_process_id");
            const auto& h=v[3];if(h.empty()||h.size()>2048||h.size()%2||h.find_first_not_of("0123456789abcdef")!=std::string::npos)throw std::runtime_error("invalid_window_title");
            std::string decoded;for(size_t i=0;i<h.size();i+=2)decoded.push_back(static_cast<char>(std::stoi(h.substr(i,2),nullptr,16)));
            if(decoded.find('\0')!=std::string::npos)throw std::runtime_error("invalid_window_title");s.title=Wide(decoded);
            if(s.title.size()>256)throw std::runtime_error("invalid_window_title");s.mode="window";s.pid=static_cast<DWORD>(pid);s.area=v[2];return s;
        }
        throw std::runtime_error("invalid_capture_source");
    }
    D3D11_BOX Box(UINT w,UINT h)const{
        const UINT left=mode=="region"?x:0,top=mode=="region"?y:0,cw=mode=="region"?width:w,ch=mode=="region"?height:h;
        if(cw<2||ch<2||static_cast<UINT64>(left)+cw>w||static_cast<UINT64>(top)+ch>h||static_cast<UINT64>(cw)*ch>33554432)throw std::runtime_error("region_out_of_bounds");
        return {left,top,0,left+cw,top+ch,1};
    }
};
static LONGLONG FrameQpc(){LARGE_INTEGER q,f;QueryPerformanceCounter(&q);QueryPerformanceFrequency(&f);return q.QuadPart/f.QuadPart*10000000+(q.QuadPart%f.QuadPart)*10000000/f.QuadPart;}
static LONGLONG QpcTicksToTime(LONGLONG ticks){LARGE_INTEGER f;QueryPerformanceFrequency(&f);return ticks/f.QuadPart*10000000+(ticks%f.QuadPart)*10000000/f.QuadPart;}
static std::string FrameUtc(LONGLONG qpc){
    FILETIME time;GetSystemTimeAsFileTime(&time);ULARGE_INTEGER t;t.LowPart=time.dwLowDateTime;t.HighPart=time.dwHighDateTime;
    t.QuadPart-=static_cast<ULONGLONG>(std::max<LONGLONG>(0,FrameQpc()-qpc));time.dwLowDateTime=t.LowPart;time.dwHighDateTime=t.HighPart;
    SYSTEMTIME s;FileTimeToSystemTime(&time,&s);char value[40];sprintf_s(value,"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",s.wYear,s.wMonth,s.wDay,s.wHour,s.wMinute,s.wSecond,s.wMilliseconds);return value;
}
class WindowCapture {
    HWND window=nullptr;DWORD processId=0;FILETIME created={};
    winrt::Windows::Graphics::Capture::GraphicsCaptureItem item{nullptr};
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool pool{nullptr};
    winrt::Windows::Graphics::Capture::GraphicsCaptureSession session{nullptr};
    struct ArrivalSignal {std::atomic<UINT64> count{0};HANDLE event=CreateEventW(nullptr,FALSE,FALSE,nullptr);~ArrivalSignal(){if(event)CloseHandle(event);}};
    std::shared_ptr<ArrivalSignal> arrivals=std::make_shared<ArrivalSignal>();UINT64 seen=0;winrt::event_token arrivalToken{};Clock::time_point lastValidation={};
    SIZE original={};
    static FILETIME Identity(DWORD pid){
        HANDLE p=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);if(!p)throw std::runtime_error("window_process_unavailable");
        FILETIME c,e,k,u;BOOL ok=GetProcessTimes(p,&c,&e,&k,&u);CloseHandle(p);if(!ok)throw std::runtime_error("window_process_unavailable");return c;
    }
public:
    std::string title;RECT bounds={},client={};
    DWORD Pid()const{return processId;}
    std::string Id()const{std::ostringstream out;out<<"window:"<<processId<<":"<<reinterpret_cast<ULONG_PTR>(window)<<":"<<created.dwHighDateTime<<":"<<created.dwLowDateTime;return out.str();}
    bool OwnsPoint(POINT p)const{return GetAncestor(WindowFromPoint(p),GA_ROOT)==window;}
    ~WindowCapture(){try{if(pool&&arrivalToken.value)pool.FrameArrived(arrivalToken);if(session)session.Close();if(pool)pool.Close();}catch(...){}}
    bool HasFrame()const{return arrivals->count.load()!=seen;}
    HANDLE FrameEvent()const{return arrivals->event;}
    void Validate(){
        lastValidation=Clock::now();
        DWORD pid=0;if(!IsWindow(window))throw std::runtime_error("window_closed");GetWindowThreadProcessId(window,&pid);
        if(pid!=processId||CompareFileTime(&created,&IdentityCopy(pid))!=0)throw std::runtime_error("window_identity_changed");
        if(IsIconic(window))throw std::runtime_error("window_minimized");if(!IsWindowVisible(window))throw std::runtime_error("window_hidden");
        if(FAILED(DwmGetWindowAttribute(window,DWMWA_EXTENDED_FRAME_BOUNDS,&bounds,sizeof(bounds))))throw std::runtime_error("window_geometry_unavailable");
        RECT r={};POINT p={0,0};if(!GetClientRect(window,&r)||!ClientToScreen(window,&p))throw std::runtime_error("window_geometry_unavailable");client={p.x,p.y,p.x+r.right,p.y+r.bottom};
        wchar_t current[512]={};GetWindowTextW(window,current,512);title=Utf8(current);
        if(bounds.right-bounds.left!=original.cx||bounds.bottom-bounds.top!=original.cy)throw std::runtime_error("source_resized");
    }
    static FILETIME& IdentityCopy(DWORD pid){thread_local FILETIME c;c=Identity(pid);return c;}
    static HWND Resolve(const CaptureSelection& source){
        struct Matches{const CaptureSelection* s;std::vector<HWND> windows;};Matches matches{&source,{}};
        EnumWindows([](HWND h,LPARAM data)->BOOL{auto& m=*reinterpret_cast<Matches*>(data);if(!IsWindowVisible(h))return TRUE;DWORD pid=0;GetWindowThreadProcessId(h,&pid);if(m.s->pid&&pid!=m.s->pid)return TRUE;
            wchar_t t[512]={};GetWindowTextW(h,t,512);if(CompareStringOrdinal(t,-1,m.s->title.c_str(),-1,TRUE)==CSTR_EQUAL)m.windows.push_back(h);return m.windows.size()<3;},reinterpret_cast<LPARAM>(&matches));
        if(matches.windows.empty())throw std::runtime_error("window_not_found");if(matches.windows.size()!=1)throw std::runtime_error("window_ambiguous");
        return matches.windows[0];
    }
    bool Matches(const CaptureSelection& source)const{return Resolve(source)==window;}
    void Begin(ID3D11Device* d,const CaptureSelection& source){
        window=Resolve(source);GetWindowThreadProcessId(window,&processId);created=Identity(processId);title=Utf8(source.title);
        try{
            using namespace winrt::Windows::Graphics::Capture;
            if(!GraphicsCaptureSession::IsSupported())throw std::runtime_error("window_capture_unsupported");
            auto factory=winrt::get_activation_factory<GraphicsCaptureItem,IGraphicsCaptureItemInterop>();
            winrt::check_hresult(factory->CreateForWindow(window,winrt::guid_of<GraphicsCaptureItem>(),winrt::put_abi(item)));
            auto size=item.Size();original={size.Width,size.Height};if(original.cx<2||original.cy<2||static_cast<UINT64>(original.cx)*original.cy>33554432)throw std::runtime_error("source_display_pixel_limit");Validate();
            ComPtr<IDXGIDevice> dxgi;Check(d->QueryInterface(IID_PPV_ARGS(&dxgi)),"window DXGI device");winrt::com_ptr<IInspectable> wrapped;
            Check(CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(),wrapped.put()),"window Direct3D device");
            auto device=wrapped.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
            pool=Direct3D11CaptureFramePool::CreateFreeThreaded(device,winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,2,size);
            arrivalToken=pool.FrameArrived([signal=arrivals](const auto&,const auto&){signal->count.fetch_add(1);if(signal->event)SetEvent(signal->event);});
            session=pool.CreateCaptureSession(item);session.IsCursorCaptureEnabled(false);session.StartCapture();
        }catch(const winrt::hresult_error& e){throw std::runtime_error("window_capture_failed: "+Utf8(std::wstring(e.message())));}
    }
    bool Next(ComPtr<ID3D11Texture2D>& texture,LONGLONG& timestamp,D3D11_BOX& box,bool cursor,const CaptureSelection& source,int freshWaitMs=0){
        UNREFERENCED_PARAMETER(cursor);
        try{
            const auto noticed=arrivals->count.load();auto frame=pool.TryGetNextFrame();seen=noticed;if(!frame){if(Clock::now()-lastValidation>=std::chrono::milliseconds(250))Validate();return false;}Validate();
            for(int n=0;n<3;n++){auto latest=pool.TryGetNextFrame();if(!latest)break;frame.Close();frame=latest;}
            // A paused consumer can leave two old frames in the pool. Bounded
            // wait requests let the producer refill after those are drained.
            const auto freshDeadline=Clock::now()+std::chrono::milliseconds(freshWaitMs);
            while(freshWaitMs&&FrameQpc()-frame.SystemRelativeTime().count()>200000&&Clock::now()<freshDeadline){auto latest=pool.TryGetNextFrame();if(latest){frame.Close();frame=latest;}else Sleep(2);}
            auto size=frame.ContentSize();if(size.Width!=original.cx||size.Height!=original.cy){frame.Close();throw std::runtime_error("source_resized");}
            auto access=frame.Surface().as<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();Check(access->GetInterface(IID_PPV_ARGS(&texture)),"window frame texture");
            timestamp=frame.SystemRelativeTime().count();
            if(source.area=="client")box={static_cast<UINT>(client.left-bounds.left),static_cast<UINT>(client.top-bounds.top),0,static_cast<UINT>(client.right-bounds.left),static_cast<UINT>(client.bottom-bounds.top),1};
            else box={0,0,0,static_cast<UINT>(original.cx),static_cast<UINT>(original.cy),1};
            // The texture reference owns this frame until the GPU copy/readback
            // completes. Retain the frame object explicitly until Done().
            held=frame;return true;
        }catch(const winrt::hresult_error& e){throw std::runtime_error("window_capture_failed: "+Utf8(std::wstring(e.message())));}
    }
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame held{nullptr};
    void Done(){if(held){try{held.Close();}catch(...){}held=nullptr;}}
};
