using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
    "http://localhost:3000", "http://127.0.0.1:3000"
};
var extraOrigin = Environment.GetEnvironmentVariable("AGENT_ALLOWED_ORIGIN");
if (!string.IsNullOrWhiteSpace(extraOrigin)) allowed.Add(extraOrigin.TrimEnd('/'));

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:8765");
var app = builder.Build();
app.UseWebSockets(new WebSocketOptions { AllowedOrigins = allowed.ToList() });

app.Map("/agent", async (HttpContext ctx) =>
{
    var provided = ctx.Request.Query["token"].ToString();
    var origin = ctx.Request.Headers.Origin.ToString();
    var goodToken = provided.Length == token.Length &&
        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(provided), Encoding.UTF8.GetBytes(token));
    if (!ctx.WebSockets.IsWebSocketRequest || !goodToken || !allowed.Contains(origin))
    {
        ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;
    }
    using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
    Console.WriteLine("Local browser connected; host consent is also required.");
    var buffer = new byte[2048];
    try
    {
        while (socket.State == WebSocketState.Open)
        {
            var result = await socket.ReceiveAsync(buffer, ctx.RequestAborted);
            if (result.MessageType == WebSocketMessageType.Close) break;
            if (result.MessageType != WebSocketMessageType.Text || !result.EndOfMessage) continue;
            try
            {
                using var doc = JsonDocument.Parse(buffer.AsSpan(0, result.Count));
                InputInjector.Handle(doc.RootElement);
            }
            catch (JsonException) { }
        }
    }
    catch (OperationCanceledException) { }
    catch (WebSocketException) { }
    finally { InputInjector.ReleaseAll(); }
});
app.MapGet("/", () => Results.Text("Remote Input Agent: loopback only."));
Console.WriteLine("Windows Input Agent listening on 127.0.0.1:8765");
Console.WriteLine("Session token (do not share): " + token);
Console.WriteLine("Allowed browser origin(s): " + string.Join(", ", allowed));
Console.WriteLine("This agent runs in the current user session; it does not bypass UAC or anti-cheat.");
await app.RunAsync();

static class InputInjector
{
    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE=0x0001, LEFTDOWN=0x0002, LEFTUP=0x0004;
    const uint RIGHTDOWN=0x0008, RIGHTUP=0x0010, MIDDLEDOWN=0x0020, MIDDLEUP=0x0040;
    const uint MOUSEEVENTF_WHEEL=0x0800, MOUSEEVENTF_VIRTUALDESK=0x4000, MOUSEEVENTF_ABSOLUTE=0x8000;
    const uint KEYEVENTF_KEYUP=0x0002;
    const int SM_XVIRTUALSCREEN=76, SM_YVIRTUALSCREEN=77, SM_CXVIRTUALSCREEN=78, SM_CYVIRTUALSCREEN=79;
    static readonly HashSet<ushort> PressedKeys = new();
    static readonly HashSet<int> PressedButtons = new();

    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {
        public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {
        public ushort wVk,wScan; public uint dwFlags,time; public UIntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)] struct INPUT {
        public uint type; public InputUnion U;
    }
    [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint nInputs, [In] INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
    static void Send(INPUT input) => SendInput(1,new[]{input},Marshal.SizeOf<INPUT>());
    static void Mouse(uint flags,int dx=0,int dy=0,uint data=0) =>
        Send(new INPUT {type=INPUT_MOUSE,U=new InputUnion {mi=new MOUSEINPUT{dx=dx,dy=dy,mouseData=data,dwFlags=flags}}});
    static void Key(ushort vk,bool down) =>
        Send(new INPUT {type=INPUT_KEYBOARD,U=new InputUnion {ki=new KEYBDINPUT{wVk=vk,dwFlags=down?0:KEYEVENTF_KEYUP}}});

    static bool GetBool(JsonElement e,string name) => e.TryGetProperty(name,out var v)&&v.ValueKind==JsonValueKind.True;
    static string GetString(JsonElement e,string name) =>
        e.TryGetProperty(name,out var v)&&v.ValueKind==JsonValueKind.String?v.GetString()??"":"";
    static double GetDouble(JsonElement e,string name) =>
        e.TryGetProperty(name,out var v)&&v.TryGetDouble(out var d)&&double.IsFinite(d)?d:0;

    public static void Handle(JsonElement e)
    {
        if(e.ValueKind!=JsonValueKind.Object)return;
        switch(GetString(e,"kind"))
        {
            case "move":
                var x=Math.Clamp(GetDouble(e,"x"),0,1);
                var y=Math.Clamp(GetDouble(e,"y"),0,1);
                // Browser video normalized coordinates target the Windows virtual desktop.
                // Multi-monitor capture/display coordinate mapping requires a future explicit monitor selector.
                Mouse(MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK,
                    (int)Math.Round(x*65535),(int)Math.Round(y*65535));
                break;
            case "button":
                var b=(int)GetDouble(e,"button");if(b<0||b>2)return;
                var down=GetBool(e,"down");
                if(down)PressedButtons.Add(b);else PressedButtons.Remove(b);
                var flag=b switch {0=>down?LEFTDOWN:LEFTUP,1=>down?MIDDLEDOWN:MIDDLEUP,_=>down?RIGHTDOWN:RIGHTUP};
                Mouse(flag);
                break;
            case "wheel":
                var delta=(int)Math.Clamp(GetDouble(e,"delta"),-120,120);
                Mouse(MOUSEEVENTF_WHEEL,data:unchecked((uint)delta));
                break;
            case "key":
                var code=GetString(e,"code");
                var vk=VirtualKey(code);
                if(vk==0)return;
                var keyDown=GetBool(e,"down");
                if(keyDown)PressedKeys.Add(vk);else PressedKeys.Remove(vk);
                Key(vk,keyDown);
                break;
        }
    }
    static ushort VirtualKey(string code)
    {
        if(code.Length==4&&code.StartsWith("Key")&&code[3]>='A'&&code[3]<='Z')return code[3];
        if(code.Length==6&&code.StartsWith("Digit")&&code[5]>='0'&&code[5]<='9')return code[5];
        if(code.StartsWith('F')&&int.TryParse(code[1..],out var f)&&f>=1&&f<=12)return (ushort)(0x6F+f);
        return code switch {
            "Backspace"=>0x08,"Tab"=>0x09,"Enter"=>0x0D,"ShiftLeft" or "ShiftRight"=>0x10,
            "ControlLeft" or "ControlRight"=>0x11,"AltLeft" or "AltRight"=>0x12,
            "Escape"=>0x1B,"Space"=>0x20,"PageUp"=>0x21,"PageDown"=>0x22,
            "End"=>0x23,"Home"=>0x24,"ArrowLeft"=>0x25,"ArrowUp"=>0x26,
            "ArrowRight"=>0x27,"ArrowDown"=>0x28,"Insert"=>0x2D,"Delete"=>0x2E,
            "MetaLeft" or "MetaRight"=>0x5B,
            "Semicolon"=>0xBA,"Equal"=>0xBB,"Comma"=>0xBC,"Minus"=>0xBD,
            "Period"=>0xBE,"Slash"=>0xBF,"Backquote"=>0xC0,
            "BracketLeft"=>0xDB,"Backslash"=>0xDC,"BracketRight"=>0xDD,
            "Quote"=>0xDE,_=>0
        };
    }
    public static void ReleaseAll()
    {
        foreach(var k in PressedKeys)Key(k,false);
        PressedKeys.Clear();
        foreach(var b in PressedButtons)
            Mouse(b switch {0=>LEFTUP,1=>MIDDLEUP,_=>RIGHTUP});
        PressedButtons.Clear();
    }
}
