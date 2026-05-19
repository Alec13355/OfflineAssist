using System;
using System.Linq;
using System.Threading.Tasks;
using Community.VisualStudio.Toolkit;
using Microsoft.VisualStudio.Shell;
using OfflineAssist.Chat;
using OfflineAssist.HuggingFace;

namespace OfflineAssist.Commands;

[Command(PackageGuids.OfflineAssistCmdSetString, PackageIds.OpenChat)]
internal sealed class OpenChatCommand : BaseCommand<OpenChatCommand>
{
    protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
    {
        await ChatWindowPane.ShowAsync();
    }
}

[Command(PackageGuids.OfflineAssistCmdSetString, PackageIds.DownloadModel)]
internal sealed class DownloadModelCommand : BaseCommand<DownloadModelCommand>
{
    protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
    {
        var pkg = OfflineAssistPackage.Instance!;
        var models = await pkg.Registry.ListAllModelsAsync();
        var uncached = models.Where(m => !m.IsCached).ToList();

        if (!uncached.Any())
        {
            await VS.MessageBox.ShowInformationAsync("OfflineAssist", "All available models are already downloaded.");
            return;
        }

        var choices = uncached.Select(m => m.DisplayName).ToArray();
        var picked = await VS.MessageBox.ShowAsync(
            "Download Model",
            $"Choose a model to download:\n\n{string.Join("\n", choices.Select((c, i) => $"{i + 1}. {c}"))}",
            OLEMSGICON.OLEMSGICON_QUERY,
            OLEMSGBUTTON.OLEMSGBUTTON_OK);

        if (picked != 1) return;

        await VS.StatusBar.ShowMessageAsync("OfflineAssist: downloading model…");

        try
        {
            var model = uncached[0];
            var source = pkg.Registry.GetSource(model.Source)!;
            await source.DownloadModelAsync(model, (msg, _) =>
                _ = VS.StatusBar.ShowMessageAsync($"OfflineAssist: {msg}"), default);
            await VS.StatusBar.ShowMessageAsync($"OfflineAssist: {model.DisplayName} downloaded.");
        }
        catch (Exception ex)
        {
            await VS.MessageBox.ShowErrorAsync("OfflineAssist", $"Download failed: {ex.Message}");
        }
    }
}

[Command(PackageGuids.OfflineAssistCmdSetString, PackageIds.RefreshModels)]
internal sealed class RefreshModelsCommand : BaseCommand<RefreshModelsCommand>
{
    protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
    {
        var pkg = OfflineAssistPackage.Instance!;
        foreach (var source in pkg.Registry.GetSources())
            await source.RefreshAsync();

        if (ChatWindowPane.Current is { } pane)
            await pane.RefreshModelsAsync();

        await VS.StatusBar.ShowMessageAsync("OfflineAssist: model catalog refreshed.");
    }
}

[Command(PackageGuids.OfflineAssistCmdSetString, PackageIds.AddHuggingFaceModel)]
internal sealed class AddHuggingFaceModelCommand : BaseCommand<AddHuggingFaceModelCommand>
{
    protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
    {
        var pkg = OfflineAssistPackage.Instance!;
        var input = await VS.MessageBox.ShowInputAsync("Add Hugging Face Model", "Enter model repo id (owner/model):");
        if (string.IsNullOrWhiteSpace(input)) return;

        try
        {
            var discovered = await pkg.HfDiscovery.DiscoverModelAsync(input);
            var compat = pkg.HfCompatibility.Assess(discovered);
            var entry = new ImportedHuggingFaceModel
            {
                RepoId = discovered.RepoId,
                Revision = discovered.Revision,
                DisplayName = discovered.DisplayName,
                AddedAt = DateTime.UtcNow.ToString("o"),
                Status = ImportedModelStatus.Validated,
                Compatibility = compat.Compatibility,
                CompatibilityReason = compat.Reason,
                RuntimeHints = compat.RuntimeHints,
                License = discovered.License,
                PipelineTag = discovered.PipelineTag,
                Tags = discovered.Tags,
                Files = discovered.Files,
            };
            pkg.HfManifest.Upsert(entry);
            await VS.MessageBox.ShowInformationAsync("OfflineAssist",
                $"Added '{discovered.RepoId}' ({compat.Compatibility}).");
        }
        catch (Exception ex)
        {
            await VS.MessageBox.ShowErrorAsync("OfflineAssist", $"Could not add model: {ex.Message}");
        }
    }
}

[Command(PackageGuids.OfflineAssistCmdSetString, PackageIds.ListHuggingFaceImports)]
internal sealed class ListHuggingFaceImportsCommand : BaseCommand<ListHuggingFaceImportsCommand>
{
    protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
    {
        var items = OfflineAssistPackage.Instance!.HfManifest.List();
        if (!items.Any())
        {
            await VS.MessageBox.ShowInformationAsync("OfflineAssist", "No Hugging Face models imported yet.");
            return;
        }

        var lines = items.Select(m =>
            $"• {m.RepoId}  [{m.Status}]  {m.Compatibility ?? "unknown"}  {(m.RuntimeBackend != null ? "— " + m.RuntimeBackend : "")}");
        await VS.MessageBox.ShowInformationAsync("OfflineAssist: HF Imports", string.Join("\n", lines));
    }
}

[Command(PackageGuids.OfflineAssistCmdSetString, PackageIds.RemoveHuggingFaceImport)]
internal sealed class RemoveHuggingFaceImportCommand : BaseCommand<RemoveHuggingFaceImportCommand>
{
    protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
    {
        var pkg = OfflineAssistPackage.Instance!;
        var items = pkg.HfManifest.List();
        if (!items.Any())
        {
            await VS.MessageBox.ShowInformationAsync("OfflineAssist", "No Hugging Face imports to remove.");
            return;
        }

        var list = string.Join("\n", items.Select((m, i) => $"{i + 1}. {m.RepoId}"));
        var input = await VS.MessageBox.ShowInputAsync("Remove HF Import", $"Enter repo id to remove:\n\n{list}");
        if (string.IsNullOrWhiteSpace(input)) return;

        var removed = pkg.HfManifest.Remove(input.Trim());
        if (removed)
        {
            var item = items.FirstOrDefault(m => m.RepoId == input.Trim());
            if (item?.LocalArtifactPath != null && System.IO.Directory.Exists(item.LocalArtifactPath))
                System.IO.Directory.Delete(item.LocalArtifactPath, recursive: true);
            await VS.MessageBox.ShowInformationAsync("OfflineAssist", $"Removed '{input.Trim()}'.");
        }
        else
        {
            await VS.MessageBox.ShowErrorAsync("OfflineAssist", $"'{input.Trim()}' was not found.");
        }
    }
}

[Command(PackageGuids.OfflineAssistCmdSetString, PackageIds.ValidateHuggingFaceImports)]
internal sealed class ValidateHuggingFaceImportsCommand : BaseCommand<ValidateHuggingFaceImportsCommand>
{
    protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
    {
        var pkg = OfflineAssistPackage.Instance!;
        var items = pkg.HfManifest.List();
        if (!items.Any())
        {
            await VS.MessageBox.ShowInformationAsync("OfflineAssist", "No Hugging Face imports to validate.");
            return;
        }

        var validated = 0;
        foreach (var item in items)
        {
            try
            {
                var discovered = await pkg.HfDiscovery.DiscoverModelAsync(item.RepoId);
                var compat = pkg.HfCompatibility.Assess(discovered);
                pkg.HfManifest.Upsert(item with
                {
                    Revision = discovered.Revision,
                    DisplayName = discovered.DisplayName,
                    Status = ImportedModelStatus.Validated,
                    Compatibility = compat.Compatibility,
                    CompatibilityReason = compat.Reason,
                    RuntimeHints = compat.RuntimeHints,
                    Tags = discovered.Tags,
                    Files = discovered.Files,
                    LastValidationError = null,
                });
                validated++;
            }
            catch (Exception ex)
            {
                pkg.HfManifest.Upsert(item with
                {
                    Status = ImportedModelStatus.Error,
                    LastValidationError = ex.Message,
                });
            }
        }

        await VS.MessageBox.ShowInformationAsync("OfflineAssist",
            $"Validated {validated}/{items.Count} Hugging Face imports.");
    }
}

[Command(PackageGuids.OfflineAssistCmdSetString, PackageIds.PrepareHuggingFaceImport)]
internal sealed class PrepareHuggingFaceImportCommand : BaseCommand<PrepareHuggingFaceImportCommand>
{
    protected override async Task ExecuteAsync(OleMenuCmdEventArgs e)
    {
        var pkg = OfflineAssistPackage.Instance!;
        var items = pkg.HfManifest.List();
        if (!items.Any())
        {
            await VS.MessageBox.ShowInformationAsync("OfflineAssist", "No Hugging Face imports to prepare.");
            return;
        }

        var list = string.Join("\n", items.Select((m, i) =>
            $"{i + 1}. {m.RepoId}  [{m.Compatibility ?? "unknown"}]"));
        var input = await VS.MessageBox.ShowInputAsync("Prepare HF Import",
            $"Enter repo id to prepare:\n\n{list}");
        if (string.IsNullOrWhiteSpace(input)) return;

        var model = items.FirstOrDefault(m => m.RepoId == input.Trim());
        if (model == null)
        {
            await VS.MessageBox.ShowErrorAsync("OfflineAssist", $"'{input.Trim()}' not found.");
            return;
        }

        if (model.Compatibility == HuggingFaceCompatibility.Unsupported)
        {
            await VS.MessageBox.ShowErrorAsync("OfflineAssist",
                $"Cannot prepare unsupported model. {model.CompatibilityReason}");
            return;
        }

        pkg.HfManifest.Upsert(model with { Status = ImportedModelStatus.Importing });
        await VS.StatusBar.ShowMessageAsync($"OfflineAssist: preparing {model.RepoId}…");

        try
        {
            var prepared = await pkg.HfImportPipeline.PrepareModelAsync(
                model with { Status = ImportedModelStatus.Importing });
            pkg.HfManifest.Upsert(prepared);
            await VS.StatusBar.ShowMessageAsync($"OfflineAssist: {model.RepoId} is ready.");
            await VS.MessageBox.ShowInformationAsync("OfflineAssist",
                $"'{model.RepoId}' prepared with backend '{prepared.RuntimeBackend}'.");
        }
        catch (Exception ex)
        {
            pkg.HfManifest.Upsert(model with
            {
                Status = ImportedModelStatus.Error,
                LastValidationError = ex.Message,
            });
            await VS.MessageBox.ShowErrorAsync("OfflineAssist", $"Preparation failed: {ex.Message}");
        }
    }
}
