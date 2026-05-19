using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace OfflineAssist.Models;

public sealed class ModelSourceRegistry
{
    private readonly Dictionary<string, IModelSource> _sources = new();
    private List<ModelEntry>? _cache;
    private DateTime _cacheExpiry = DateTime.MinValue;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

    public IReadOnlyList<IModelSource> GetSources() => _sources.Values.ToList();

    public void Register(IModelSource source)
    {
        if (_sources.ContainsKey(source.SourceId))
            throw new InvalidOperationException($"Source '{source.SourceId}' is already registered.");
        _sources[source.SourceId] = source;
        InvalidateCache();
    }

    public void Unregister(string sourceId)
    {
        if (_sources.Remove(sourceId))
            InvalidateCache();
    }

    public IModelSource? GetSource(string sourceId) =>
        _sources.TryGetValue(sourceId, out var s) ? s : null;

    public async Task<IReadOnlyList<ModelEntry>> ListAllModelsAsync(CancellationToken cancellationToken = default)
    {
        if (_cache != null && DateTime.UtcNow < _cacheExpiry)
            return _cache;

        var all = new List<ModelEntry>();
        foreach (var source in _sources.Values)
        {
            try
            {
                var models = await source.ListChatModelsAsync(cancellationToken);
                all.AddRange(models);
            }
            catch { /* continue; individual source failure is non-fatal */ }
        }

        all.Sort((a, b) => string.Compare(a.DisplayName, b.DisplayName, StringComparison.OrdinalIgnoreCase));
        _cache = all;
        _cacheExpiry = DateTime.UtcNow + CacheTtl;
        return all;
    }

    public async Task<ModelEntry?> ResolveModelAsync(string modelId, CancellationToken cancellationToken = default)
    {
        var colonIndex = modelId.IndexOf(':');
        if (colonIndex > 0)
        {
            var sourceId = modelId[..colonIndex];
            var actualId = modelId[(colonIndex + 1)..];
            return _sources.TryGetValue(sourceId, out var src)
                ? await src.ResolveModelAsync(actualId, cancellationToken)
                : null;
        }

        foreach (var source in _sources.Values)
        {
            var model = await source.ResolveModelAsync(modelId, cancellationToken);
            if (model != null) return model;
        }

        return null;
    }

    private void InvalidateCache()
    {
        _cache = null;
        _cacheExpiry = DateTime.MinValue;
    }
}
