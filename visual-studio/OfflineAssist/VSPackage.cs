using System;
using System.Runtime.InteropServices;
using System.Threading;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Shell;
using OfflineAssist.Commands;
using OfflineAssist.HuggingFace;
using OfflineAssist.Models;
using Task = System.Threading.Tasks.Task;

namespace OfflineAssist;

[PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
[InstalledProductRegistration("OfflineAssist", "Run local AI models inside Visual Studio.", "0.1.0")]
[ProvideMenuResource("Menus.ctmenu", 1)]
[ProvideToolWindow(typeof(Chat.ChatWindowPane), Style = VsDockStyle.Tabbed, Window = EnvDTE.Constants.vsWindowKindOutput)]
[Guid(PackageGuids.OfflineAssistPackageString)]
public sealed class OfflineAssistPackage : ToolkitPackage
{
    internal static OfflineAssistPackage? Instance { get; private set; }

    internal ModelSourceRegistry Registry { get; } = new();
    internal FoundryLocalClient FoundryClient { get; } = new();
    internal HuggingFaceDiscoveryService HfDiscovery { get; } = new();
    internal HuggingFaceCompatibilityService HfCompatibility { get; } = new();
    internal HuggingFaceManifest HfManifest { get; private set; } = null!;
    internal HuggingFaceRuntimeService HfRuntime { get; private set; } = null!;
    internal HuggingFaceImportPipeline HfImportPipeline { get; private set; } = null!;

    protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
    {
        Instance = this;

        var storageRoot = System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OfflineAssist");
        System.IO.Directory.CreateDirectory(storageRoot);

        HfManifest = new HuggingFaceManifest(storageRoot);
        HfRuntime = new HuggingFaceRuntimeService();
        HfImportPipeline = new HuggingFaceImportPipeline(storageRoot);

        var foundrySource = new FoundryModelSource(FoundryClient);
        Registry.Register(foundrySource);

        await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
        await this.RegisterCommandsAsync();
    }
}
