// MIT. Source-sized GPU staging: never read an entire display for a region.
#pragma once
#include "CaptureSource.h"
class Capture {
    ComPtr<ID3D11Device> device;ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDXGIOutputDuplication> duplication;ComPtr<ID3D11Texture2D> staging;
    std::unique_ptr<WindowCapture> window;
    CaptureSelection selection;D3D11_BOX box={};UINT textureWidth=0,textureHeight=0;
    bool separatePointer=true;std::wstring lastDesktop;LONGLONG stamp=0;UINT64 sequence=0;
    bool reused=false;std::string id="fullscreen";
    void DeviceOnly(){if(device)return;Check(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&device,nullptr,&context),"capture D3D device");}
    void Copy(ID3D11Texture2D* texture,const D3D11_BOX& region){
        D3D11_TEXTURE2D_DESC source;texture->GetDesc(&source);
        if(!source.Width||!source.Height||static_cast<UINT64>(source.Width)*source.Height>33554432||region.left>=region.right||region.top>=region.bottom||region.right>source.Width||region.bottom>source.Height)throw std::runtime_error("region_out_of_bounds");
        if(source.Format!=DXGI_FORMAT_B8G8R8A8_UNORM)throw std::runtime_error("unsupported_pixel_format");
        const UINT width=region.right-region.left,height=region.bottom-region.top;
        D3D11_TEXTURE2D_DESC previous={};if(staging)staging->GetDesc(&previous);
        if(!staging||previous.Width!=width||previous.Height!=height){
            D3D11_TEXTURE2D_DESC desc={};desc.Width=width;desc.Height=height;desc.MipLevels=desc.ArraySize=1;desc.Format=source.Format;desc.SampleDesc.Count=1;desc.Usage=D3D11_USAGE_STAGING;desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
            staging.Reset();Check(device->CreateTexture2D(&desc,nullptr,&staging),"source-sized staging texture");
        }
        context->CopySubresourceRegion(staging.Get(),0,0,0,0,texture,0,&region);
        box=region;textureWidth=source.Width;textureHeight=source.Height;
    }
    void Overlay(Frame& frame){
        if(frame.cursor.x<Left()||frame.cursor.y<Top()||frame.cursor.x>=Left()+static_cast<LONG>(frame.width)||frame.cursor.y>=Top()+static_cast<LONG>(frame.height))return;
        CURSORINFO pointer={sizeof(CURSORINFO)};
        if(!GetCursorInfo(&pointer)||!(pointer.flags&CURSOR_SHOWING))return;
        ICONINFO icon={};if(!GetIconInfo(pointer.hCursor,&icon))return;
        BITMAPINFO bitmap={};bitmap.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);bitmap.bmiHeader.biWidth=frame.width;bitmap.bmiHeader.biHeight=-static_cast<LONG>(frame.height);bitmap.bmiHeader.biPlanes=1;bitmap.bmiHeader.biBitCount=32;bitmap.bmiHeader.biCompression=BI_RGB;
        void* pixels=nullptr;HDC dc=CreateCompatibleDC(nullptr);HBITMAP dib=CreateDIBSection(dc,&bitmap,DIB_RGB_COLORS,&pixels,nullptr,0);
        if(dc&&dib&&pixels){const auto old=SelectObject(dc,dib);memcpy(pixels,frame.pixels.data(),frame.pixels.size());
            DrawIconEx(dc,frame.cursor.x-Left()-static_cast<LONG>(icon.xHotspot),frame.cursor.y-Top()-static_cast<LONG>(icon.yHotspot),pointer.hCursor,0,0,0,nullptr,DI_NORMAL);
            memcpy(frame.pixels.data(),pixels,frame.pixels.size());SelectObject(dc,old);frame.cursorIncluded=true;}
        if(dib)DeleteObject(dib);if(dc)DeleteDC(dc);if(icon.hbmColor)DeleteObject(icon.hbmColor);if(icon.hbmMask)DeleteObject(icon.hbmMask);
    }
public:
    ComPtr<IWICImagingFactory> wic;
    Capture(){Check(CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&wic)),"WIC factory");}
    void Reset(){window.reset();duplication.Reset();staging.Reset();context.Reset();device.Reset();stamp=0;box={};}
    void Configure(const std::string& key,bool pinned){
        const auto next=CaptureSelection::Parse(key);if(pinned&&key!=selection.key)throw std::runtime_error("source_busy");
        if(key!=selection.key||(!pinned&&window&&!window->Matches(next))){Reset();selection=next;id=key;sequence=0;}
    }
    bool Fullscreen()const{return selection.mode=="fullscreen";}
    bool WindowSource()const{return selection.mode=="window";}
    UINT Width()const{return box.right-box.left;}UINT Height()const{return box.bottom-box.top;}
    std::string ImageMetadata(const Frame& image)const{
        std::ostringstream out;const double sx=static_cast<double>(Width())/image.width,sy=static_cast<double>(Height())/image.height;
        out<<"\"imageToHost\":{\"offsetX\":"<<Left()<<",\"offsetY\":"<<Top()<<",\"scaleX\":"<<sx<<",\"scaleY\":"<<sy<<"},\"cursorInImage\":{\"x\":"<<(image.cursor.x-Left())/sx<<",\"y\":"<<(image.cursor.y-Top())/sy<<"}";return out.str();
    }
    LONG Left()const{return window?(selection.area=="client"?window->client.left:window->bounds.left):static_cast<LONG>(box.left);}
    LONG Top()const{return window?(selection.area=="client"?window->client.top:window->bounds.top):static_cast<LONG>(box.top);}
    void Initialize(){
        if(RequireConsole()!=L"Default")throw std::runtime_error("default_desktop_required_for_dxgi");
        ComPtr<IDXGIFactory1> factory;Check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)),"DXGI factory");
        for(UINT a=0;;++a){ComPtr<IDXGIAdapter1> adapter;if(factory->EnumAdapters1(a,&adapter)==DXGI_ERROR_NOT_FOUND)break;
            for(UINT o=0;;++o){ComPtr<IDXGIOutput> output;if(adapter->EnumOutputs(o,&output)==DXGI_ERROR_NOT_FOUND)break;
                DXGI_OUTPUT_DESC desc={};Check(output->GetDesc(&desc),"output description");if(!desc.AttachedToDesktop)continue;
                MONITORINFO info={sizeof(MONITORINFO)};if(!GetMonitorInfoW(desc.Monitor,&info)||!(info.dwFlags&MONITORINFOF_PRIMARY))continue;
                if(desc.DesktopCoordinates.left||desc.DesktopCoordinates.top)throw std::runtime_error("primary_origin_not_supported");
                Check(D3D11CreateDevice(adapter.Get(),D3D_DRIVER_TYPE_UNKNOWN,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&device,nullptr,&context),"D3D device");
                ComPtr<IDXGIOutput1> modern;Check(output.As(&modern),"DXGI output");Check(modern->DuplicateOutput(device.Get(),&duplication),"desktop duplication");return;
            }
        }throw std::runtime_error("primary_display_unavailable");
    }
    Frame Grab(bool cursor,int waitMs=0){
        // CopySubresourceRegion is asynchronous. Keep the duplication surface
        // owned until Map has completed the GPU readback, including on errors.
        struct DesktopFrame {
            ComPtr<IDXGIOutputDuplication> owner;
            HRESULT Finish(){auto current=std::move(owner);return current?current->ReleaseFrame():S_OK;}
            ~DesktopFrame(){Finish();}
        } desktopFrame;
        const auto desktop=RequireConsole();if(desktop!=lastDesktop){Reset();lastDesktop=desktop;}
        if(desktop==L"Winlogon"){
            if(!Fullscreen())throw std::runtime_error("source_desktop_changed");
            Frame frame=SecureDesktopFrame(cursor);if(RequireConsole()!=desktop)throw std::runtime_error("desktop_changed_during_secure_capture");
            box={0,0,0,frame.width,frame.height,1};textureWidth=frame.width;textureHeight=frame.height;stamp=FrameQpc();sequence++;reused=false;return frame;
        }
        if(selection.mode=="window"&&!window){DeviceOnly();auto candidate=std::make_unique<WindowCapture>();candidate->Begin(device.Get(),selection);window=std::move(candidate);}
        if(selection.mode!="window"&&!duplication)Initialize();
        const auto deadline=Clock::now()+std::chrono::milliseconds(staging?waitMs:1500);reused=true;
        for(;;){
            if(selection.mode=="window"){
                ComPtr<ID3D11Texture2D> texture;LONGLONG timestamp=0;D3D11_BOX region={};
                if(window->Next(texture,timestamp,region,false,selection)){
                    try{Copy(texture.Get(),region);stamp=timestamp;sequence++;reused=false;}catch(...){window->Done();throw;}
                    // Map below before releasing the source frame.
                    break;
                }
            }else{
                if(!duplication)Initialize();ComPtr<IDXGIResource> resource;DXGI_OUTDUPL_FRAME_INFO info={};
                const HRESULT hr=duplication->AcquireNextFrame(0,&info,&resource);
                if(hr==DXGI_ERROR_ACCESS_LOST){Reset();throw std::runtime_error("display_configuration_changed");}
                if(hr!=DXGI_ERROR_WAIT_TIMEOUT){Check(hr,"acquire desktop frame");
                    desktopFrame.owner=duplication;
                    try{
                        if(info.LastMouseUpdateTime.QuadPart)separatePointer=info.PointerPosition.Visible!=FALSE;
                        // A first pointer-only update has no desktop pixels.
                        // Never initialize staging (or its timestamp) from it.
                        if(!info.LastPresentTime.QuadPart){
                            Check(desktopFrame.Finish(),"release pointer-only frame");
                            if(Clock::now()>=deadline)break;Sleep(2);continue;
                        }
                        DXGI_OUTDUPL_DESC output;duplication->GetDesc(&output);if(output.Rotation!=DXGI_MODE_ROTATION_IDENTITY&&output.Rotation!=DXGI_MODE_ROTATION_UNSPECIFIED)throw std::runtime_error("rotated_display_not_supported");
                        ComPtr<ID3D11Texture2D> texture;Check(resource.As(&texture),"desktop texture");D3D11_TEXTURE2D_DESC desc;texture->GetDesc(&desc);
                        // Pointer-only updates do not claim a new content frame.
                        Copy(texture.Get(),selection.Box(desc.Width,desc.Height));stamp=QpcTicksToTime(info.LastPresentTime.QuadPart);sequence++;reused=false;
                    }catch(...){throw;}break;
                }
            }
            if(Clock::now()>=deadline)break;Sleep(2);
        }
        if(!staging)throw std::runtime_error("source_frame_unavailable");
        Frame frame;frame.width=box.right-box.left;frame.height=box.bottom-box.top;frame.pixels.resize(static_cast<size_t>(frame.width)*frame.height*4);
        D3D11_MAPPED_SUBRESOURCE mapped={};
        try{Check(context->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped),"map selected source");
            for(UINT row=0;row<frame.height;row++)memcpy(frame.pixels.data()+static_cast<size_t>(row)*frame.width*4,static_cast<BYTE*>(mapped.pData)+static_cast<size_t>(row)*mapped.RowPitch,frame.width*4);
            context->Unmap(staging.Get(),0);if(window)window->Done();
            Check(desktopFrame.Finish(),"release desktop frame");
        }catch(...){if(window)window->Done();throw;}
        if(RequireConsole()!=desktop){Reset();throw std::runtime_error("desktop_changed_during_capture");}
        GetCursorPos(&frame.cursor);
        if(cursor){if(!window&&!separatePointer)frame.cursorIncluded=true;else if(!window||window->OwnsPoint(frame.cursor))Overlay(frame);}
        for(size_t i=3;i<frame.pixels.size();i+=4)frame.pixels[i]=255;return frame;
    }
    std::string Metadata(const Frame& frame)const{
        std::ostringstream out;out<<"\"source\":{\"mode\":"<<Json(selection.mode)<<",\"backend\":"<<Json(frame.desktop=="Winlogon"?"secure-desktop-broker":window?"windows-graphics-capture":"dxgi")<<",\"sourceId\":"<<Json(window?window->Id()+":"+selection.area:id);
        if(window)out<<",\"title\":"<<Json(window->title)<<",\"processId\":"<<window->Pid()<<",\"area\":"<<Json(selection.area);
        out<<"},\"left\":"<<Left()<<",\"top\":"<<Top()<<",\"sourceWidth\":"<<frame.width<<",\"sourceHeight\":"<<frame.height<<",\"textureWidth\":"<<textureWidth<<",\"textureHeight\":"<<textureHeight;
        out<<",\"primaryWidth\":"<<GetSystemMetrics(SM_CXSCREEN)<<",\"primaryHeight\":"<<GetSystemMetrics(SM_CYSCREEN)<<",\"readbackBytes\":"<<static_cast<UINT64>(frame.width)*frame.height*4<<",\"capturedUtc\":"<<Json(FrameUtc(stamp))<<",\"frameSequence\":"<<sequence<<",\"reusedFrame\":"<<(reused?"true":"false")<<",\"frameAgeMs\":"<<std::max<LONGLONG>(0,(FrameQpc()-stamp)/10000);return out.str();
    }
    Frame Scale(const Frame& frame,UINT width,bool even){
        UINT w=width?std::min(width,frame.width):frame.width,h=static_cast<UINT>(static_cast<UINT64>(frame.height)*w/frame.width);if(even){w&=~1U;h&=~1U;}
        if(w<2||h<2)throw std::runtime_error("invalid_frame_dimensions");if(w==frame.width&&h==frame.height)return frame;
        Frame result;result.width=w;result.height=h;result.cursor=frame.cursor;result.cursorIncluded=frame.cursorIncluded;result.desktop=frame.desktop;result.uacPromptId=frame.uacPromptId;
        ComPtr<IWICBitmap> bitmap;Check(wic->CreateBitmapFromMemory(frame.width,frame.height,GUID_WICPixelFormat32bppBGRA,frame.width*4,static_cast<UINT>(frame.pixels.size()),const_cast<BYTE*>(frame.pixels.data()),&bitmap),"scale source");
        ComPtr<IWICBitmapScaler> scaler;Check(wic->CreateBitmapScaler(&scaler),"image scaler");Check(scaler->Initialize(bitmap.Get(),w,h,WICBitmapInterpolationModeFant),"scale selected source");
        result.pixels.resize(static_cast<size_t>(w)*h*4);Check(scaler->CopyPixels(nullptr,w*4,static_cast<UINT>(result.pixels.size()),result.pixels.data()),"scaled pixels");return result;
    }
    Frame Scale(Frame&& frame,UINT width,bool even){if((!width||width>=frame.width)&&(!even||(!(frame.width&1)&&!(frame.height&1))))return std::move(frame);return Scale(static_cast<const Frame&>(frame),width,even);}
    void Save(const Frame& frame,const fs::path& path,bool jpeg){
        if(fs::exists(path))throw std::runtime_error("output_already_exists");ComPtr<IWICStream> stream;Check(wic->CreateStream(&stream),"image stream");Check(stream->InitializeFromFilename(path.c_str(),GENERIC_WRITE),"image output");
        ComPtr<IWICBitmapEncoder> encoder;Check(wic->CreateEncoder(jpeg?GUID_ContainerFormatJpeg:GUID_ContainerFormatPng,nullptr,&encoder),"image encoder");Check(encoder->Initialize(stream.Get(),WICBitmapEncoderNoCache),"image encoder init");
        ComPtr<IWICBitmapFrameEncode> output;ComPtr<IPropertyBag2> properties;Check(encoder->CreateNewFrame(&output,&properties),"image frame");
        if(jpeg){PROPBAG2 option={};option.pstrName=const_cast<LPOLESTR>(L"ImageQuality");VARIANT quality;VariantInit(&quality);quality.vt=VT_R4;quality.fltVal=0.85f;Check(properties->Write(1,&option,&quality),"JPEG quality");VariantClear(&quality);}
        Check(output->Initialize(properties.Get()),"initialize image frame");Check(output->SetSize(frame.width,frame.height),"image dimensions");
        WICPixelFormatGUID format=GUID_WICPixelFormat24bppBGR;Check(output->SetPixelFormat(&format),"image pixel format");ComPtr<IWICBitmap> bitmap;
        Check(wic->CreateBitmapFromMemory(frame.width,frame.height,GUID_WICPixelFormat32bppBGRA,frame.width*4,static_cast<UINT>(frame.pixels.size()),const_cast<BYTE*>(frame.pixels.data()),&bitmap),"image bitmap");
        ComPtr<IWICFormatConverter> converter;Check(wic->CreateFormatConverter(&converter),"pixel converter");Check(converter->Initialize(bitmap.Get(),format,WICBitmapDitherTypeNone,nullptr,0,WICBitmapPaletteTypeCustom),"convert image pixels");
        Check(output->WriteSource(converter.Get(),nullptr),"write image");Check(output->Commit(),"commit image frame");Check(encoder->Commit(),"commit image");
    }
};
