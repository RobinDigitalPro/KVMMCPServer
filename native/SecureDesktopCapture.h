// MIT. Read-only SYSTEM broker frame client. No privileged file or process API.
#pragma once
#include <winsvc.h>
static Frame SecureDesktopFrame(bool cursor) {
    const wchar_t* name=L"\\\\.\\pipe\\KVMMCPServer.SecureDesktop.v1";
    HANDLE pipe=CreateFileW(name,GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION,nullptr);
    if(pipe==INVALID_HANDLE_VALUE&&GetLastError()==ERROR_PIPE_BUSY){if(!WaitNamedPipeW(name,200))throw std::runtime_error("secure_desktop_busy");pipe=CreateFileW(name,GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,SECURITY_SQOS_PRESENT|SECURITY_IDENTIFICATION,nullptr);}
    if(pipe==INVALID_HANDLE_VALUE)throw std::runtime_error("secure_desktop_service_unavailable");
    try {
        ULONG actual=0;SC_HANDLE manager=OpenSCManagerW(nullptr,nullptr,SC_MANAGER_CONNECT);
        SC_HANDLE service=manager?OpenServiceW(manager,L"KVMMCPServerSecureDesktop",SERVICE_QUERY_STATUS):nullptr;
        SERVICE_STATUS_PROCESS status={};DWORD needed=0;
        bool valid=service&&QueryServiceStatusEx(service,SC_STATUS_PROCESS_INFO,reinterpret_cast<BYTE*>(&status),sizeof(status),&needed)&&status.dwCurrentState==SERVICE_RUNNING&&GetNamedPipeServerProcessId(pipe,&actual)&&actual==status.dwProcessId;
        if(service)CloseServiceHandle(service);if(manager)CloseServiceHandle(manager);
        if(!valid)throw std::runtime_error("secure_desktop_server_identity_mismatch");
        const std::string request=cursor?"{\"op\":\"frame\",\"includeCursor\":true}":"{\"op\":\"frame\",\"includeCursor\":false}";
        const DWORD length=static_cast<DWORD>(request.size());DWORD written=0;
        if(!WriteFile(pipe,&length,sizeof(length),&written,nullptr)||written!=sizeof(length)||!WriteFile(pipe,request.data(),length,&written,nullptr)||written!=length)throw std::runtime_error("secure_desktop_request_failed");
        auto read=[&](void* output,DWORD count){auto bytes=static_cast<BYTE*>(output);DWORD at=0;while(at<count){DWORD got=0;if(!ReadFile(pipe,bytes+at,count-at,&got,nullptr)||!got)throw std::runtime_error("secure_desktop_frame_incomplete");at+=got;}};
        BYTE header[64];read(header,sizeof(header));
        auto u32=[&](size_t at){UINT value=0;memcpy(&value,header+at,4);return value;};
        DWORD current=0;ProcessIdToSessionId(GetCurrentProcessId(),&current);
        if(u32(0)!=0x31464355||u32(4)!=1||u32(8)!=0||u32(12)!=current||(u32(36)&255)!=2)throw std::runtime_error("secure_desktop_capture_unavailable");
        Frame frame;frame.width=u32(16);frame.height=u32(20);
        const uint64_t bytes=static_cast<uint64_t>(frame.width)*frame.height*4;
        if(!frame.width||!frame.height||bytes>64ull*1024*1024||bytes!=u32(32))throw std::runtime_error("secure_desktop_frame_size_invalid");
        frame.cursor.x=static_cast<LONG>(u32(24));frame.cursor.y=static_cast<LONG>(u32(28));frame.cursorIncluded=(u32(36)&256)!=0;
        frame.desktop="Winlogon";GUID id;memcpy(&id,header+48,sizeof(id));wchar_t text[40]={};if(StringFromGUID2(id,text,40)!=39)throw std::runtime_error("secure_prompt_identity_invalid");frame.uacPromptId=Utf8(std::wstring(text+1,36));
        frame.pixels.resize(static_cast<size_t>(bytes));read(frame.pixels.data(),static_cast<DWORD>(bytes));
        for(size_t i=3;i<frame.pixels.size();i+=4)frame.pixels[i]=255;
        CloseHandle(pipe);return frame;
    }catch(...){CloseHandle(pipe);throw;}
}
