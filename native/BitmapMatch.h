// MIT. Bounded CPU bitmap matching. Scores are similarities, not probabilities.
#pragma once
#include <array>
#include <numeric>
struct BitmapTap {UINT x,y;BYTE b,g,r;};
struct BitmapTemplate {
    UINT width=0,height=0;POINT anchor={};std::vector<BitmapTap> taps,anchors;
    void Prepare(UINT w,UINT h,const BYTE* bgra,POINT hotspot,UINT maximum){
        if(w<2||h<2||w>maximum||h>maximum||hotspot.x<0||hotspot.y<0||hotspot.x>=static_cast<LONG>(w)||hotspot.y>=static_cast<LONG>(h))throw std::runtime_error("invalid_bitmap_dimensions_or_anchor");
        width=w;height=h;anchor=hotspot;taps.clear();anchors.clear();std::array<UINT,4096> counts={};
        for(UINT y=0;y<h;y++)for(UINT x=0;x<w;x++){const auto p=bgra+(static_cast<size_t>(y)*w+x)*4;if(p[3]>=200){taps.push_back({x,y,p[0],p[1],p[2]});counts[(p[0]>>4)|((p[1]>>4)<<4)|((p[2]>>4)<<8)]++;}}
        if(taps.size()<8)throw std::runtime_error("bitmap_needs_eight_opaque_pixels");
        const auto frequency=[&](const BitmapTap& p){return counts[(p.b>>4)|((p.g>>4)<<4)|((p.r>>4)<<8)];};
        std::stable_sort(taps.begin(),taps.end(),[&](const BitmapTap& a,const BitmapTap& b){return frequency(a)<frequency(b);});
        const LONG spacing=std::max<LONG>(2,std::min(w,h)/4);
        for(const auto& p:taps){if(std::all_of(anchors.begin(),anchors.end(),[&](const BitmapTap& q){return std::abs(static_cast<LONG>(p.x)-static_cast<LONG>(q.x))>=spacing||std::abs(static_cast<LONG>(p.y)-static_cast<LONG>(q.y))>=spacing;}))anchors.push_back(p);if(anchors.size()==12)break;}
        if(anchors.size()<4)anchors.assign(taps.begin(),taps.begin()+std::min<size_t>(12,taps.size()));
    }
};
static BitmapTemplate LoadBitmap(Capture& capture,const fs::path& file,UINT maximum,POINT anchor){
    if(!fs::is_regular_file(file)||fs::file_size(file)>32768)throw std::runtime_error("bitmap_file_limit");
    ComPtr<IWICBitmapDecoder> decoder;Check(capture.wic->CreateDecoderFromFilename(file.c_str(),nullptr,GENERIC_READ,WICDecodeMetadataCacheOnDemand,&decoder),"bitmap PNG decoder");
    GUID container;Check(decoder->GetContainerFormat(&container),"bitmap container");if(container!=GUID_ContainerFormatPng)throw std::runtime_error("bitmap_must_be_png");
    UINT count=0;Check(decoder->GetFrameCount(&count),"bitmap frame count");if(count!=1)throw std::runtime_error("bitmap_must_be_single_frame");
    ComPtr<IWICBitmapFrameDecode> frame;Check(decoder->GetFrame(0,&frame),"bitmap frame");UINT w=0,h=0;Check(frame->GetSize(&w,&h),"bitmap dimensions");
    if(w<2||h<2||w>maximum||h>maximum)throw std::runtime_error("bitmap_dimension_limit");
    if(anchor.x<0)anchor.x=w/2;if(anchor.y<0)anchor.y=h/2;
    ComPtr<IWICFormatConverter> convert;Check(capture.wic->CreateFormatConverter(&convert),"bitmap converter");Check(convert->Initialize(frame.Get(),GUID_WICPixelFormat32bppBGRA,WICBitmapDitherTypeNone,nullptr,0,WICBitmapPaletteTypeCustom),"bitmap BGRA");
    std::vector<BYTE> pixels(static_cast<size_t>(w)*h*4);Check(convert->CopyPixels(nullptr,w*4,static_cast<UINT>(pixels.size()),pixels.data()),"bitmap pixels");
    BitmapTemplate result;result.Prepare(w,h,pixels.data(),anchor,maximum);return result;
}
struct BitmapPeak {LONG x=0,y=0;double score=0;};
struct BitmapResult {
    bool found=false;std::string reason="not_found";BitmapPeak best;double secondScore=0,elapsedMs=0;UINT64 positions=0,comparisons=0;bool complete=true;
};
static BitmapResult FindBitmap(const Frame& image,const BitmapTemplate& pattern,double minimum,double margin,bool broad,int budgetMs){
    BitmapResult out;const auto started=Clock::now(),deadline=started+std::chrono::milliseconds(budgetMs);std::vector<BitmapPeak> peaks;bool overflow=false;
    if(image.width<pattern.width||image.height<pattern.height){out.reason="source_smaller_than_bitmap";return out;}
    const UINT64 allowed=static_cast<UINT64>((1-std::max(0.0,minimum-margin))*765*pattern.taps.size());const LONG radius=std::max<LONG>(2,std::min(pattern.width,pattern.height)/2);
    const auto error=[](const BYTE* p,const BitmapTap& t){return std::abs(static_cast<int>(p[0])-t.b)+std::abs(static_cast<int>(p[1])-t.g)+std::abs(static_cast<int>(p[2])-t.r);};
    for(UINT y=0;y<=image.height-pattern.height;y++)for(UINT x=0;x<=image.width-pattern.width;x++){
        if((out.positions++&255)==0&&Clock::now()>=deadline){out.complete=false;goto done;}
        {UINT bad=0;const size_t count=broad?pattern.anchors.size():std::min<size_t>(8,pattern.anchors.size());for(size_t n=0;n<count;n++){const auto& p=pattern.anchors[n];out.comparisons++;if(error(image.pixels.data()+(static_cast<size_t>(y+p.y)*image.width+x+p.x)*4,p)>144)bad++;}if(bad>count/4)continue;}
        UINT64 total=0;for(const auto& p:pattern.taps){out.comparisons++;total+=error(image.pixels.data()+(static_cast<size_t>(y+p.y)*image.width+x+p.x)*4,p);if(total>allowed)break;}
        if(total>allowed)continue;const double score=1-static_cast<double>(total)/(765*pattern.taps.size());
        bool merged=false;for(auto& peak:peaks)if(std::abs(peak.x-static_cast<LONG>(x))<radius&&std::abs(peak.y-static_cast<LONG>(y))<radius){if(score>peak.score)peak={static_cast<LONG>(x),static_cast<LONG>(y),score};merged=true;break;}
        if(!merged){if(peaks.size()>=128){overflow=true;goto done;}peaks.push_back({static_cast<LONG>(x),static_cast<LONG>(y),score});}
    }
done:
    out.elapsedMs=std::chrono::duration<double,std::milli>(Clock::now()-started).count();
    std::sort(peaks.begin(),peaks.end(),[](const BitmapPeak& a,const BitmapPeak& b){return a.score>b.score;});
    if(!peaks.empty()){out.best=peaks[0];if(peaks.size()>1)out.secondScore=peaks[1].score;}
    if(!out.complete)out.reason="search_budget";
    else if(overflow||(peaks.size()>1&&out.best.score-out.secondScore<margin))out.reason="ambiguous";
    else if(!peaks.empty()&&out.best.score>=minimum){out.found=true;out.reason="";}
    return out;
}
