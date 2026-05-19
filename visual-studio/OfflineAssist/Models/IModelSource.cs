using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace OfflineAssist.Models;

public interface IModelSource
{
    string SourceId { get; }
    string DisplayName { get; }

    Task<IReadOnlyList<ModelEntry>> ListChatModelsAsync(CancellationToken cancellationToken = default);
    Task<ModelEntry?> ResolveModelAsync(string modelId, CancellationToken cancellationToken = default);
    Task PrepareModelAsync(ModelEntry model, Action<string, double?> reporter, CancellationToken cancellationToken = default);
    Task DownloadModelAsync(ModelEntry model, Action<string, double?> reporter, CancellationToken cancellationToken = default);
    Task RefreshAsync();
}
