// MIT. Deterministic software cursor, independent of native cursor metadata.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
sealed class TrackingFixture:Form {
    [DllImport("user32.dll")]static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int height,uint flags);
    Bitmap sprite;readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer{Interval=10};
    int x=80,y=120,dx=3,frame;bool visible=true,duplicate;
    protected override bool ShowWithoutActivation{get{return true;}}
    static Bitmap Pattern(int size){var b=new Bitmap(size,size,PixelFormat.Format32bppArgb);for(int py=1;py<size-2;py++)for(int px=1;px<size-2;px++)if(px<=py/2+1||py>size/2&&px>size/4&&px<size/2){bool edge=px==1||px==py/2+1||py==size-3;b.SetPixel(px,py,edge?Color.FromArgb(255,9,17,25):Color.FromArgb(255,80+px*5%160,70+py*7%170,60+(px+py)*3%180));}return b;}
    TrackingFixture(string title,string root){Text=title;ClientSize=new Size(640,360);Location=new Point(80,80);StartPosition=FormStartPosition.Manual;DoubleBuffered=true;
        Directory.CreateDirectory(root);sprite=Pattern(32);sprite.Save(Path.Combine(root,"cursor32.png"),ImageFormat.Png);using(var b=Pattern(48))b.Save(Path.Combine(root,"cursor48.png"),ImageFormat.Png);using(var b=Pattern(49))b.Save(Path.Combine(root,"cursor49.png"),ImageFormat.Png);
        Paint+=(s,e)=>{e.Graphics.Clear(Color.FromArgb(26,53,91));e.Graphics.FillRectangle(Brushes.DarkSlateBlue,350,50,150,200);e.Graphics.DrawString("Frame "+frame,Font,Brushes.White,4,4);if(visible)e.Graphics.DrawImageUnscaled(sprite,x,y);if(duplicate)e.Graphics.DrawImageUnscaled(sprite,500,240);};
        timer.Tick+=(s,e)=>{frame++;x+=dx;if(x>ClientSize.Width-50){x=ClientSize.Width-50;dx=-Math.Abs(dx);}if(x<20){x=20;dx=Math.Abs(dx);}Invalidate();};
        Shown+=(s,e)=>{SetWindowPos(Handle,new IntPtr(1),0,0,0,0,0x0013);timer.Start();Reply("ready");new Thread(ReadCommands){IsBackground=true}.Start();};
    }
    void Reply(string op){var r=RectangleToScreen(ClientRectangle);Console.WriteLine(new JavaScriptSerializer().Serialize(new{operation=op,title=Text,processId=System.Diagnostics.Process.GetCurrentProcess().Id,left=r.Left,top=r.Top,width=r.Width,height=r.Height,x=x,y=y,frame=frame}));Console.Out.Flush();}
    void ReadCommands(){for(;;){string op=Console.ReadLine();if(op==null){BeginInvoke((Action)(()=>Close()));return;}BeginInvoke((Action)(()=>{if(op=="close"){Close();return;}if(op=="pause")dx=0;else if(op=="run")dx=3;else if(op=="teleport")x=x<320?500:40;else if(op=="hide")visible=false;else if(op=="show")visible=true;else if(op=="duplicate")duplicate=true;else if(op=="single")duplicate=false;else if(op=="size48"){sprite.Dispose();sprite=Pattern(48);}else if(op=="front")SetWindowPos(Handle,new IntPtr(-1),0,0,0,0,0x0013);else if(op=="resize")ClientSize=new Size(680,380);Invalidate();Reply(op);}));}}
    [STAThread]static void Main(string[] args){SetProcessDpiAwarenessContext(new IntPtr(-4));Application.EnableVisualStyles();Application.Run(new TrackingFixture(args[0],args[1]));}
}
