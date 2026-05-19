using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;

namespace OfflineAssist.HuggingFace;

public sealed class HuggingFaceImportPipeline
{
    private readonly string _storageRoot;
    private readonly HttpClient _http = new();

    public HuggingFaceImportPipeline(string storageRoot) => _storageRoot = storageRoot;

    public async Task<ImportedHuggingFaceModel> PrepareModelAsync(ImportedHuggingFaceModel model)
    {
        var safeName = model.RepoId.Replace('/', '_').Replace('\\', '_');
        var folder = Path.Combine(_storageRoot, "huggingface-models", safeName);
        Directory.CreateDirectory(folder);

        var backend = HfRuntimeBackend.HfHosted;
        string? localModelFile = null;

        var ggufCandidates = (model.Files ?? [])
            .Where(f => f.Path.EndsWith(".gguf", StringComparison.OrdinalIgnoreCase))
            .OrderBy(f => f.Size ?? long.MaxValue)
            .ToList();

        if (ggufCandidates.Any() && model.Compatibility == HuggingFaceCompatibility.Direct)
        {
            var preferred = PickPreferredGguf(ggufCandidates);
            var fileName = Path.GetFileName(preferred.Path);
            var dest = Path.Combine(folder, fileName);
            await DownloadFileAsync(model.RepoId, model.Revision, preferred.Path, dest);
            backend = HfRuntimeBackend.LocalLlamaCpp;
            localModelFile = dest;
        }

        var metadata = new
        {
            model.RepoId,
            model.Revision,
            Compatibility = model.Compatibility?.ToString(),
            model.CompatibilityReason,
            model.Tags,
            RuntimeBackend = backend.ToString(),
            LocalModelFile = localModelFile,
            PreparedAt = DateTime.UtcNow.ToString("o"),
        };
        await File.WriteAllTextAsync(
            Path.Combine(folder, "metadata.json"),
            JsonSerializer.Serialize(metadata, new JsonSerializerOptions { WriteIndented = true }));

        return model with
        {
            Status = ImportedModelStatus.Ready,
            RuntimeBackend = backend,
            LocalArtifactPath = folder,
            LocalModelFile = localModelFile,
            LastValidationError = null,
        };
    }

    private static HuggingFaceFile PickPreferredGguf(List<HuggingFaceFile> files)
    {
        string[] qualityHints = ["q4_k_m", "q4_k_s", "q5_k_m", "q6_k"];
        foreach (var hint in qualityHints)
        {
            var match = files.FirstOrDefault(f => f.Path.Contains(hint, StringComparison.OrdinalIgnoreCase));
            if (match != null) return match;
        }
        return files[0];
    }

    private async Task DownloadFileAsync(string repoId, string revision, string modelPath, string destination)
    {
        var encodedPath = string.Join("/", modelPath.Split('/').Select(Uri.EscapeDataString));
        var url = $"https://huggingface.co/{repoId}/resolve/{Uri.EscapeDataString(revision)}/{encodedPath}";

        using var response = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync();
        await using var file = File.Create(destination);
        await stream.CopyToAsync(file);
    }

    public Task RemoveArtifactsAsync(ImportedHuggingFaceModel model)
    {
        if (model.LocalArtifactPath != null && Directory.Exists(model.LocalArtifactPath))
            Directory.Delete(model.LocalArtifactPath, recursive: true);
        return Task.CompletedTask;
    }
}
