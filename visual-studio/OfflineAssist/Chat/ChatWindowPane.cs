using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Shell;

namespace OfflineAssist.Chat;

[Guid("B7E4F2A1-3C9D-4E8B-A5F0-2D1C3E4B5F6A")]
public sealed class ChatWindowPane : ToolWindowPane
{
    public static ChatWindowPane? Current { get; private set; }

    private ChatWindowControl? _control;

    public ChatWindowPane() : base(null)
    {
        Caption = "OfflineAssist Chat";
    }

    protected override void Initialize()
    {
        base.Initialize();
        _control = new ChatWindowControl();
        Content = _control;
        Current = this;
    }

    public static async Task ShowAsync()
    {
        var window = await VS.Windows.ShowToolWindowAsync<ChatWindowPane>();
        if (window?.Content is ChatWindowControl ctrl)
            await ctrl.InitializeAsync();
    }

    public async Task RefreshModelsAsync()
    {
        if (_control != null)
            await _control.RefreshModelsAsync();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            Current = null;
            _control?.Dispose();
        }
        base.Dispose(disposing);
    }
}
