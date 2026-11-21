// MIT. A disposable user-mode worker, never a limit on the HID/controller process.
#pragma once
#include <psapi.h>

static constexpr SIZE_T MediaCommitLimit=512ULL*1024*1024;
static constexpr DWORD MediaCpuRate=500; // Windows units: 10000 == entire machine.
static bool MediaLimitsActive(){
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={};JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu={};
    return QueryInformationJobObject(nullptr,JobObjectExtendedLimitInformation,&limits,sizeof(limits),nullptr)&&
        QueryInformationJobObject(nullptr,JobObjectCpuRateControlInformation,&cpu,sizeof(cpu),nullptr)&&
        (limits.BasicLimitInformation.LimitFlags&JOB_OBJECT_LIMIT_PROCESS_MEMORY)&&limits.ProcessMemoryLimit<=MediaCommitLimit&&
        (cpu.ControlFlags&(JOB_OBJECT_CPU_RATE_CONTROL_ENABLE|JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP))==(JOB_OBJECT_CPU_RATE_CONTROL_ENABLE|JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP)&&cpu.CpuRate<=MediaCpuRate;
}
static int GuardMediaWorker(const fs::path& root,const std::wstring& diagnostic=L""){
    if(!root.is_absolute()||root.wstring().find_first_of(L"\"\r\n")!=std::wstring::npos)throw std::runtime_error("invalid_data_root");
    HANDLE job=CreateJobObjectW(nullptr,nullptr);if(!job)throw std::runtime_error("media_job_create_failed");
    PROCESS_INFORMATION process={};HANDLE inherited[3]={};LPPROC_THREAD_ATTRIBUTE_LIST attributes=nullptr;std::vector<BYTE> storage;
    try{
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_PROCESS_MEMORY|JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.ProcessMemoryLimit=MediaCommitLimit;limits.BasicLimitInformation.ActiveProcessLimit=1;
        if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))throw std::runtime_error("media_memory_limit_failed");
        JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu={};cpu.ControlFlags=JOB_OBJECT_CPU_RATE_CONTROL_ENABLE|JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;cpu.CpuRate=MediaCpuRate;
        if(!SetInformationJobObject(job,JobObjectCpuRateControlInformation,&cpu,sizeof(cpu)))throw std::runtime_error("media_cpu_limit_failed");
        const DWORD ids[3]={STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE};
        for(int index=0;index<3;index++)if(!DuplicateHandle(GetCurrentProcess(),GetStdHandle(ids[index]),GetCurrentProcess(),&inherited[index],0,TRUE,DUPLICATE_SAME_ACCESS))throw std::runtime_error("media_pipe_duplicate_failed");
        SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,1,0,&size);storage.resize(size);auto list=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        if(!InitializeProcThreadAttributeList(list,1,0,&size))throw std::runtime_error("media_handle_list_failed");attributes=list;
        if(!UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited,sizeof(inherited),nullptr,nullptr))throw std::runtime_error("media_handle_list_failed");
        wchar_t executable[32768]={};if(!GetModuleFileNameW(nullptr,executable,32768))throw std::runtime_error("media_executable_path_failed");
        std::wstring command=L"\""+std::wstring(executable)+(diagnostic.empty()?L"\" serve --data-root \"":L"\" self-test-buffer \"")+root.wstring()+L"\""+diagnostic;
        STARTUPINFOEXW startup={};startup.StartupInfo.cb=sizeof(startup);startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput=inherited[0];startup.StartupInfo.hStdOutput=inherited[1];startup.StartupInfo.hStdError=inherited[2];startup.lpAttributeList=attributes;
        const BOOL created=CreateProcessW(executable,command.data(),nullptr,nullptr,TRUE,CREATE_NO_WINDOW|CREATE_SUSPENDED|EXTENDED_STARTUPINFO_PRESENT,nullptr,nullptr,&startup.StartupInfo,&process);
        DeleteProcThreadAttributeList(attributes);attributes=nullptr;
        for(auto& handle:inherited){CloseHandle(handle);handle=nullptr;}
        if(!created)throw std::runtime_error("media_worker_create_failed");
        if(!AssignProcessToJobObject(job,process.hProcess))throw std::runtime_error("media_worker_limit_assignment_failed");
        if(ResumeThread(process.hThread)==MAXDWORD)throw std::runtime_error("media_worker_resume_failed");
        CloseHandle(process.hThread);process.hThread=nullptr;
        WaitForSingleObject(process.hProcess,INFINITE);DWORD code=1;GetExitCodeProcess(process.hProcess,&code);CloseHandle(process.hProcess);process.hProcess=nullptr;CloseHandle(job);return static_cast<int>(code);
    }catch(...){
        if(attributes)DeleteProcThreadAttributeList(attributes);
        for(auto handle:inherited)if(handle)CloseHandle(handle);
        if(process.hProcess){TerminateProcess(process.hProcess,1);CloseHandle(process.hProcess);}if(process.hThread)CloseHandle(process.hThread);CloseHandle(job);throw;
    }
}
class MediaBudget {
    Clock::time_point checked=Clock::now();ULONGLONG previousCpu=0;unsigned hot=0;
    static ULONGLONG Cpu(){FILETIME created,exited,kernel,user;if(!GetProcessTimes(GetCurrentProcess(),&created,&exited,&kernel,&user))throw std::runtime_error("media_usage_unavailable");ULARGE_INTEGER k,u;k.LowPart=kernel.dwLowDateTime;k.HighPart=kernel.dwHighDateTime;u.LowPart=user.dwLowDateTime;u.HighPart=user.dwHighDateTime;return k.QuadPart+u.QuadPart;}
public:
    SIZE_T privateBytes=0;double cpuPercent=0;
    MediaBudget(){previousCpu=Cpu();}
    static bool MemoryAdmitted(ULONGLONG available){return available>=512ULL*1024*1024;}
    static void Admit(){MEMORYSTATUSEX system={};system.dwLength=sizeof(system);if(!GlobalMemoryStatusEx(&system)||!MemoryAdmitted(system.ullAvailPhys))throw std::runtime_error("insufficient_available_memory");}
    void CheckUsage(bool stopOnCpu=true){
        const auto now=Clock::now();const double seconds=std::chrono::duration<double>(now-checked).count();if(seconds<1)return;
        PROCESS_MEMORY_COUNTERS_EX memory={};memory.cb=sizeof(memory);if(!GetProcessMemoryInfo(GetCurrentProcess(),reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory),sizeof(memory)))throw std::runtime_error("media_usage_unavailable");privateBytes=memory.PrivateUsage;
        const auto total=Cpu();cpuPercent=static_cast<double>(total-previousCpu)/10000000/seconds/std::max<DWORD>(1,GetActiveProcessorCount(ALL_PROCESSOR_GROUPS))*100;previousCpu=total;checked=now;
        MEMORYSTATUSEX system={};system.dwLength=sizeof(system);if(!GlobalMemoryStatusEx(&system))throw std::runtime_error("media_usage_unavailable");
        if(privateBytes>384ULL*1024*1024)throw std::runtime_error("memory_pressure");
        if(system.ullAvailPhys<256ULL*1024*1024)throw std::runtime_error("system_memory_pressure");
        hot=cpuPercent>=4.5?hot+1:0;if(stopOnCpu&&hot>=5)throw std::runtime_error("cpu_pressure");
    }
    std::string Status()const{std::ostringstream out;out<<"\"resources\":{\"privateBytes\":"<<privateBytes<<",\"cpuPercent\":"<<cpuPercent<<",\"cpuHardCapPercent\":5,\"privateCommitLimitBytes\":"<<MediaCommitLimit<<",\"cpuTime100ns\":"<<Cpu()<<",\"cpuSampleTicks100ns\":"<<FrameQpc()<<",\"logicalProcessors\":"<<std::max<DWORD>(1,GetActiveProcessorCount(ALL_PROCESSOR_GROUPS))<<",\"limitsActive\":"<<(MediaLimitsActive()?"true":"false")<<"}";return out.str();}
};
