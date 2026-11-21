// MIT. One connection-owned CPU tracker; no HID injection or automatic clicks.
#pragma once
#include "BitmapMatch.h"
class BitmapTracking {
    BitmapTemplate bitmap;double minimum=.95,margin=.02;bool cursor=true;
    std::string identity,sourceKey,sourceId,sourceInfo="\"source\":null",state="idle",reason,frameId,capturedUtc;
    BitmapResult last;POINT position={},bounds={};UINT width=0,height=0;UINT64 visual=0,frames=0,searches=0,readbackBytes=0,revision=0;LONGLONG captureTime=0;
    std::vector<double> timings;Clock::time_point started,lastHealth={};double totalMatchMs=0,maxMatchMs=0;
    void Apply(Capture& capture,Frame& image,bool broad){
        if(!image.width)return;
        if(image.desktop!="Default")throw std::runtime_error("tracking_desktop_changed");
        if(!sourceId.empty()&&capture.SourceId()!=sourceId)throw std::runtime_error("tracking_source_identity_changed");
        if(!broad&&(image.fullWidth!=width||image.fullHeight!=height))throw std::runtime_error("tracking_source_resized");
        sourceId=capture.SourceId();sourceInfo=capture.Metadata(image);width=image.fullWidth;height=image.fullHeight;visual=image.visualSequence;
        readbackBytes=static_cast<UINT64>(image.width)*image.height*4;frames++;revision++;
        last=FindBitmap(image,bitmap,minimum,margin,broad,broad?150:8);
        totalMatchMs+=last.elapsedMs;maxMatchMs=std::max(maxMatchMs,last.elapsedMs);timings.push_back(last.elapsedMs);if(timings.size()>256)timings.erase(timings.begin());
        if(last.found){bounds={last.best.x+static_cast<LONG>(image.originX),last.best.y+static_cast<LONG>(image.originY)};position={bounds.x+bitmap.anchor.x,bounds.y+bitmap.anchor.y};state="tracking";reason="";captureTime=image.capturedTicks;capturedUtc=FrameUtc(captureTime);frameId=identity+":"+std::to_string(visual);}
        else{state="lost";reason=last.reason;}
    }
public:
    bool Pinned()const{return state=="tracking"||state=="lost";}
    bool Active()const{return state=="tracking";}
    const std::string& Id()const{return identity;}
    const std::string& State()const{return state;}
    const std::string& SourceKey()const{return sourceKey;}
    void Stop(const std::string& why="requested"){if(state!="idle"&&state!="stopped"){revision++;state="stopped";reason=why;bitmap.taps.clear();bitmap.taps.shrink_to_fit();bitmap.anchors.clear();}}
    void Lost(const std::string& why){if(Pinned()){revision++;state="lost";reason=why;}}
    void Start(Capture& capture,const fs::path& root,const std::string& id,const std::string& templateId,const std::string& source,int minScore,int separation,POINT anchor,bool includeCursor,bool otherPinned){
        if(Pinned())throw std::runtime_error("tracking_already_active");
        if(RequireConsole()!=L"Default")throw std::runtime_error("default_desktop_required");MediaBudget::Admit();
        auto loaded=LoadBitmap(capture,root/L"templates"/fs::u8path(templateId+".png"),48,anchor);
        capture.Configure(source,otherPinned);bitmap=std::move(loaded);identity=id;sourceKey=source;sourceId="";minimum=minScore/1000.0;margin=separation/1000.0;cursor=includeCursor;
        state="lost";reason="initializing";visual=frames=searches=readbackBytes=revision=0;captureTime=0;frameId="";capturedUtc="";timings.clear();totalMatchMs=maxMatchMs=0;started=Clock::now();
        Locate(capture,otherPinned);
    }
    void Locate(Capture& capture,bool otherPinned){
        if(state!="lost")return; // No broad search while tracking or stopped.
        searches++;revision++;
        try{if(RequireConsole()!=L"Default")throw std::runtime_error("default_desktop_required");
            // Recover geometry of the same window only on explicit lost locate.
            if(!otherPinned&&reason.find("resized")!=std::string::npos)capture.Reset();
            capture.Configure(sourceKey,otherPinned);auto image=capture.Grab(cursor,100,nullptr,MAXUINT64,8388608);Apply(capture,image,true);
        }catch(const std::exception& error){reason=error.what();if(reason.find("desktop")!=std::string::npos||reason.find("session")!=std::string::npos||reason.find("identity_changed")!=std::string::npos)Stop(reason);else state="lost";}
    }
    void Tick(Capture& capture){
        if(!Active())return;
        if(!capture.HasFrameHint(cursor,visual)&&Clock::now()-lastHealth<std::chrono::milliseconds(250))return;
        lastHealth=Clock::now();
        try{if(RequireConsole()!=L"Default")throw std::runtime_error("tracking_desktop_changed");
            capture.Configure(sourceKey,true);
            const LONG rw=std::min<LONG>(128,width),rh=std::min<LONG>(128,height);
            const LONG x=std::clamp<LONG>(bounds.x+static_cast<LONG>(bitmap.width)/2-rw/2,0,static_cast<LONG>(width)-rw),y=std::clamp<LONG>(bounds.y+static_cast<LONG>(bitmap.height)/2-rh/2,0,static_cast<LONG>(height)-rh);
            RECT roi={x,y,x+rw,y+rh};auto image=capture.Grab(cursor,0,&roi,visual,16384);Apply(capture,image,false);
        }catch(const std::exception& error){const std::string why=error.what();if(why.find("desktop")!=std::string::npos||why.find("session")!=std::string::npos||why.find("identity_changed")!=std::string::npos)Stop(why);else Lost(why);}
    }
    std::string Status()const{
        auto sorted=timings;std::sort(sorted.begin(),sorted.end());const double p95=sorted.empty()?0:sorted[static_cast<size_t>((sorted.size()-1)*.95)];
        std::ostringstream out;out<<"\"trackingId\":"<<Json(identity)<<",\"revision\":"<<revision<<",\"state\":"<<Json(state)<<",\"reason\":"<<Json(reason)<<",\"valid\":"<<(Active()?"true":"false")<<",\"processing\":\"cpu\",\"searchWindow\":128,\"templateWidth\":"<<bitmap.width<<",\"templateHeight\":"<<bitmap.height<<",\"anchor\":{\"x\":"<<bitmap.anchor.x<<",\"y\":"<<bitmap.anchor.y<<"}";
        const auto point=[&](){out<<"{\"x\":"<<position.x<<",\"y\":"<<position.y<<"}";};
        out<<",\"position\":";if(Active())point();else out<<"null";
        out<<",\"bounds\":";if(Active())out<<"{\"x\":"<<bounds.x<<",\"y\":"<<bounds.y<<",\"width\":"<<bitmap.width<<",\"height\":"<<bitmap.height<<"}";else out<<"null";
        out<<",\"lastKnownPosition\":";if(captureTime)point();else out<<"null";
        out<<",\"frameId\":"<<Json(frameId)<<",\"observedUtc\":"<<Json(capturedUtc)<<",\"measurementAgeMs\":"<<(captureTime?std::max<LONGLONG>(0,(FrameQpc()-captureTime)/10000):-1)<<",\"matchScore\":"<<last.best.score<<",\"secondScore\":"<<last.secondScore<<",\"matchMs\":"<<last.elapsedMs<<",\"matchP95Ms\":"<<p95<<",\"maxMatchMs\":"<<maxMatchMs<<",\"averageMatchMs\":"<<(frames?totalMatchMs/frames:0)<<",\"framesProcessed\":"<<frames<<",\"fullSearches\":"<<searches<<",\"trackingReadbackBytes\":"<<readbackBytes<<",\"uptimeMs\":"<<(identity.empty()?0:std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now()-started).count())<<","<<sourceInfo;return out.str();
    }
};
