// MIT. Read-only Windows keyboard-layout planning; injection stays in VHF.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

namespace OpenDesktopHid {
    internal sealed class TextStroke { public int key {get;set;} public int modifiers {get;set;} }
    internal sealed class TextContext { public string window {get;set;} public string foregroundLayout {get;set;} public bool capsLock {get;set;} }
    internal sealed class TextPlan { public TextStroke[] strokes {get;set;} public TextContext context {get;set;} public string mappingLayout {get;set;} public int characters {get;set;} }
    internal static class KeyboardText {
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
        [DllImport("user32.dll")] private static extern IntPtr GetKeyboardLayout(uint thread);
        [DllImport("user32.dll")] private static extern int GetKeyboardLayoutList(int count,[Out] IntPtr[] layouts);
        [DllImport("user32.dll")] private static extern short GetKeyState(int key);
        [DllImport("imm32.dll")] private static extern bool ImmIsIME(IntPtr layout);
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern uint MapVirtualKeyEx(uint key,uint mode,IntPtr layout);
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int ToUnicodeEx(uint key,uint scan,byte[] state,[Out] StringBuilder text,int count,uint flags,IntPtr layout);
        // USB keyboard page -> PC set-1 position, independent of printed legends.
        private static readonly ushort[] Scans={0,0,0,0,0x1e,0x30,0x2e,0x20,0x12,0x21,0x22,0x23,0x17,0x24,0x25,0x26,0x32,0x31,0x18,0x19,0x10,0x13,0x1f,0x14,0x16,0x2f,0x11,0x2d,0x15,0x2c,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0a,0x0b,0x1c,0x01,0x0e,0x0f,0x39,0x0c,0x0d,0x1a,0x1b,0x2b,0x2b,0x27,0x28,0x29,0x33,0x34,0x35,0x3a,0x3b,0x3c,0x3d,0x3e,0x3f,0x40,0x41,0x42,0x43,0x44,0x57,0x58,0xe037,0x46,0xe11d,0xe052,0xe047,0xe049,0xe053,0xe04f,0xe051,0xe04d,0xe04b,0xe050,0xe048,0x45,0xe035,0x37,0x4a,0x4e,0xe01c,0x4f,0x50,0x51,0x4b,0x4c,0x4d,0x47,0x48,0x49,0x52,0x53,0x56,0xe05d};
        private static int Usage(uint scan){for(int key=4;key<Scans.Length;key++)if(Scans[key]==scan)return key;return 0;}
        private static string Hex(IntPtr value){return value.ToInt64().ToString("x",CultureInfo.InvariantCulture);}
        private static TextContext Context(){
            DesktopSession.RequireConsole();IntPtr window=GetForegroundWindow();uint pid;uint thread=GetWindowThreadProcessId(window,out pid);
            if(window==IntPtr.Zero||thread==0)throw new SecurePolicyException("No foreground window for text input");
            return new TextContext{window=Hex(window),foregroundLayout=Hex(GetKeyboardLayout(thread)),capsLock=(GetKeyState(0x14)&1)!=0};
        }
        internal static void RequireContext(Dictionary<string,object> request){
            object raw;if(!request.TryGetValue("textContext",out raw))return;
            var expected=raw as Dictionary<string,object>;if(expected==null)throw new SecurePolicyException("Invalid text input context");
            var actual=Context();object caps;
            if(!expected.TryGetValue("capsLock",out caps)||!(caps is bool)||actual.window!=expected["window"] as string||actual.foregroundLayout!=expected["foregroundLayout"] as string||actual.capsLock!=(bool)caps)throw new SecurePolicyException("Text input target, layout or Caps Lock changed; input stopped");
        }
        private static IntPtr Layout(string requested,TextContext context){
            if(String.IsNullOrEmpty(requested)||requested=="active")return new IntPtr(long.Parse(context.foregroundLayout,NumberStyles.HexNumber,CultureInfo.InvariantCulture));
            if(String.Equals(requested,"Belgian (Period)",StringComparison.OrdinalIgnoreCase))requested="00000813";
            uint klid;if(requested.Length!=8||!uint.TryParse(requested,NumberStyles.HexNumber,CultureInfo.InvariantCulture,out klid)||klid==0||klid>0xffff)throw new SecurePolicyException("Use active, Belgian (Period), or an eight-digit loaded base Windows layout ID");
            int count=GetKeyboardLayoutList(0,null);if(count<1||count>256)throw new SecurePolicyException("No supported loaded keyboard layouts");
            var layouts=new IntPtr[count];count=GetKeyboardLayoutList(count,layouts);
            uint expected=(klid<<16)|klid;
            for(int i=0;i<count;i++)if(unchecked((uint)layouts[i].ToInt64())==expected)return layouts[i];
            throw new SecurePolicyException("Requested keyboard layout is not loaded in this Windows session; no layout was changed");
        }
        private static void Tables(IntPtr layout,bool caps,out Dictionary<char,TextStroke> direct,out Dictionary<char,TextStroke> dead){
            direct=new Dictionary<char,TextStroke>();dead=new Dictionary<char,TextStroke>();
            foreach(int shift in new[]{0,1,6,7})for(uint vk=8;vk<255;vk++){
                if(vk>=0x60&&vk<=0x6f)continue; // Prefer main keyboard positions.
                uint scan=MapVirtualKeyEx(vk,4,layout);int key=Usage(scan);if(key==0)continue;
                byte[] state=new byte[256];if(caps)state[0x14]=1;
                if((shift&1)!=0)state[0x10]=0x80;
                if((shift&2)!=0)state[0x11]=0x80;
                if((shift&4)!=0){state[0x12]=0x80;state[0xa5]=0x80;}
                var output=new StringBuilder(8);int result=ToUnicodeEx(vk,scan,state,output,output.Capacity,4,layout);
                if(result==0||Math.Abs(result)!=1||output.Length<1)continue;char value=output[0];
                if(char.IsControl(value)||char.IsSurrogate(value))continue;
                var stroke=new TextStroke{key=key,modifiers=((shift&1)!=0?2:0)|((shift&6)==6?64:0)};
                var target=result<0?dead:direct;if(!target.ContainsKey(value))target.Add(value,stroke);
            }
        }
        private static char Accent(char mark){switch(mark){case '\u0300':return '`';case '\u0301':return '\u00b4';case '\u0302':return '^';case '\u0303':return '~';case '\u0308':return '\u00a8';case '\u030a':return '\u00b0';case '\u0327':return '\u00b8';default:return '\0';}}
        internal static TextPlan Plan(string text,string requested){
            if(String.IsNullOrEmpty(text)||text.Length>1024)throw new SecurePolicyException("text must contain 1..1024 UTF-16 units");
            if(text.Any(char.IsSurrogate))throw new SecurePolicyException("Supplementary or unpaired Unicode characters cannot be typed by this physical layout; no text input sent");
            TextContext context=Context();IntPtr layout=Layout(requested,context);
            if(ImmIsIME(layout)||(unchecked((uint)layout.ToInt64())&0xf0000000)==0xe0000000)throw new SecurePolicyException("IME composition layouts are not supported for physical text planning");
            Dictionary<char,TextStroke> direct,dead;Tables(layout,context.capsLock,out direct,out dead);
            text=text.Replace("\r\n","\n").Replace('\r','\n').Normalize(NormalizationForm.FormC);
            var strokes=new List<TextStroke>();
            for(int index=0;index<text.Length;index++){
                char value=text[index];TextStroke stroke;
                if(value=='\n'||value=='\t'){strokes.Add(new TextStroke{key=value=='\n'?40:43,modifiers=0});continue;}
                if(direct.TryGetValue(value,out stroke)){strokes.Add(stroke);continue;}
                TextStroke space;if(dead.TryGetValue(value,out stroke)&&direct.TryGetValue(' ',out space)){strokes.Add(stroke);strokes.Add(space);continue;}
                if(!char.IsSurrogate(value)&&!char.IsControl(value)){
                    string decomposed=value.ToString().Normalize(NormalizationForm.FormD);TextStroke accent,baseKey;
                    if(decomposed.Length==2&&dead.TryGetValue(Accent(decomposed[1]),out accent)&&direct.TryGetValue(decomposed[0],out baseKey)){strokes.Add(accent);strokes.Add(baseKey);continue;}
                }
                throw new SecurePolicyException("Character U+"+((int)value).ToString("X4")+" at index "+index+" cannot be produced by this keyboard layout; no text input sent");
            }
            var after=Context();if(after.window!=context.window||after.foregroundLayout!=context.foregroundLayout||after.capsLock!=context.capsLock)throw new SecurePolicyException("Text input context changed during planning");
            return new TextPlan{strokes=strokes.ToArray(),context=context,mappingLayout=Hex(layout),characters=text.Length};
        }
        internal static void SelfTest(){if(Scans.Length!=102||Usage(0x1e)!=4||Usage(0x10)!=20||Usage(0x56)!=100||Usage(0xe048)!=82||Accent('\u0302')!='^')throw new Exception("Keyboard position mapping failed");}
    }
}
