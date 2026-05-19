using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace OfflineAssist.Models;

public sealed class FoundryModelSource : IModelSource
{
    public string SourceId => "foundry";
    public string DisplayName => "Foundry Local";

    private readonly FoundryLocalClient _client;
    private IReadOnlyList<ModelEntry>? _cache;
    private DateTime _cacheExpiry = DateTime.MinValue;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

    public FoundryModelSource(FoundryLocalClient client) => _client = client;

    public async Task<IReadOnlyList<ModelEntry>> ListChatModelsAsync(CancellationToken cancellationToken = default)
    {
        if (_cache != null && DateTime.UtcNow < _cacheExpiry)
            return _cache;

        var raw = await _client.ListModelsAsync(cancellationToken);
        _cache = raw.Select(m => new ModelEntry
        {
            Id = m.Id,
            Alias = m.Id,
            DisplayName = PrettyName(m.Id),
            Source = SourceId,
            IsCached = m.IsCached,
            IsLoaded = m.IsLoaded,
            SizeMb = m.SizeMb,
            SupportsToolCalling = m.SupportsToolCalling,
            Backend = "foundry",
            RuntimeStatus = m.IsLoaded ? "loaded" : m.IsCached ? "cached" : "remote",
        }).ToList();

        _cacheExpiry = DateTime.UtcNow + CacheTtl;
        return _cache;
    }

    public async Task<ModelEntry?> ResolveModelAsync(string modelId, CancellationToken cancellationToken = default)
    {
        var models = await ListChatModelsAsync(cancellationToken);
        return models.FirstOrDefault(m => m.Id == modelId);
    }

    public async Task PrepareModelAsync(ModelEntry model, Action<string, double?> reporter, CancellationToken cancellationToken = default)
    {
        if (!model.IsCached)
            await DownloadModelAsync(model, reporter, cancellationToken);
    }

    public async Task DownloadModelAsync(ModelEntry model, Action<string, double?> reporter, CancellationToken cancellationToken = default)
    {
        reporter("Starting download…", null);
        await _client.DownloadModelAsync(model.Id, msg => reporter(msg, null), cancellationToken);
        model.IsCached = true;
        InvalidateCache();
    }

    public Task RefreshAsync()
    {
        InvalidateCache();
        return Task.CompletedTask;
    }

    private void InvalidateCache()
    {
        _cache = null;
        _cacheExpiry = DateTime.MinValue;
    }

    private static string PrettyName(string id) =>
        id.Contains('/') ? id[(id.LastIndexOf('/') + 1)..] : id;
}
