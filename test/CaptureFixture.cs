// MIT. Own deterministic capture fixture. Never reads or injects input.
using System;
using System.Drawing;
using System.Windows.Forms;
using System.Threading;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
internal sealed class CaptureFixture : Form {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int w,int h,uint flags);
    protected override bool ShowWithoutActivation { get { return true; } }
    int frame;readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer {Interval=100};
    CaptureFixture(string title){Text=title;StartPosition=FormStartPosition.Manual;Location=new Point(60,60);ClientSize=new Size(640,360);BackColor=Color.FromArgb(20,80,160);DoubleBuffered=true;
        Paint+=(s,e)=>{e.Graphics.Clear(BackColor);using(var brush=new SolidBrush(Color.FromArgb(210,40,90)))e.Graphics.FillRectangle(brush,10,10,100,100);e.Graphics.DrawString("KVM capture "+frame,Font,Brushes.White,140,40);};
        timer.Tick+=(s,e)=>{frame++;Invalidate();};Shown+=(s,e)=>{SetWindowPos(Handle,new IntPtr(1),0,0,0,0,0x0013);timer.Start();Reply("ready");new Thread(ReadCommands){IsBackground=true}.Start();};
    }
    void Reply(string op){var r=RectangleToScreen(ClientRectangle);Console.WriteLine(new JavaScriptSerializer().Serialize(new{operation=op,title=Text,processId=System.Diagnostics.Process.GetCurrentProcess().Id,left=r.Left,top=r.Top,width=r.Width,height=r.Height,primaryWidth=Screen.PrimaryScreen.Bounds.Width,primaryHeight=Screen.PrimaryScreen.Bounds.Height}));Console.Out.Flush();}
    void ReadCommands(){for(;;){string cmd=Console.ReadLine();if(cmd==null){BeginInvoke((Action)(()=>Close()));return;}BeginInvoke((Action)(()=>{if(cmd=="close"){Close();return;}if(cmd=="resize")ClientSize=new Size(680,380);else if(cmd=="move")Location=new Point(100,100);else if(cmd=="minimize")WindowState=FormWindowState.Minimized;else if(cmd=="restore")WindowState=FormWindowState.Normal;else if(cmd=="hide")Hide();else if(cmd=="show")Show();Reply(cmd);}));}}
    [STAThread]static void Main(string[] args){SetProcessDpiAwarenessContext(new IntPtr(-4));Application.EnableVisualStyles();Application.Run(new CaptureFixture(args[0]));}
}
