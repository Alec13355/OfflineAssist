namespace OfflineAssist.Models;

public sealed class ModelEntry
{
    public string Id { get; init; } = string.Empty;
    public string Alias { get; init; } = string.Empty;
    public string DisplayName { get; init; } = string.Empty;
    public string Source { get; init; } = string.Empty;
    public bool IsCached { get; set; }
    public bool IsLoaded { get; set; }
    public long? SizeMb { get; init; }
    public bool SupportsToolCalling { get; init; }
    public string? Backend { get; init; }
    public string? RuntimeStatus { get; set; }
}
