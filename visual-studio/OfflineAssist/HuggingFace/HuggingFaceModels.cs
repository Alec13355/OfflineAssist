using System.Collections.Generic;

namespace OfflineAssist.HuggingFace;

public enum HuggingFaceCompatibility { Direct, Convertible, Unsupported }
public enum ImportedModelStatus { Discovered, Validated, Importing, Ready, Error }
public enum HfRuntimeBackend { HfHosted, LocalLlamaCpp }

public sealed record HuggingFaceModelDiscovery
{
    public string RepoId { get; init; } = string.Empty;
    public string Revision { get; init; } = "main";
    public string DisplayName { get; init; } = string.Empty;
    public string? Sha { get; init; }
    public string? License { get; init; }
    public List<string> Tags { get; init; } = [];
    public List<HuggingFaceFile> Files { get; init; } = [];
    public string? PipelineTag { get; init; }
    public long? Downloads { get; init; }
    public long? Likes { get; init; }
    public string? LastModified { get; init; }
}

public sealed record HuggingFaceFile(string Path, long? Size);

public sealed record HuggingFaceCompatibilityResult(
    HuggingFaceCompatibility Compatibility,
    string Reason,
    List<string> RuntimeHints);

public sealed record ImportedHuggingFaceModel
{
    public string RepoId { get; init; } = string.Empty;
    public string Revision { get; init; } = "main";
    public string DisplayName { get; init; } = string.Empty;
    public string AddedAt { get; init; } = string.Empty;
    public ImportedModelStatus Status { get; init; }
    public HuggingFaceCompatibility? Compatibility { get; init; }
    public string? CompatibilityReason { get; init; }
    public List<string>? RuntimeHints { get; init; }
    public HfRuntimeBackend? RuntimeBackend { get; init; }
    public string? License { get; init; }
    public string? PipelineTag { get; init; }
    public List<string> Tags { get; init; } = [];
    public List<HuggingFaceFile>? Files { get; init; }
    public string? LocalArtifactPath { get; init; }
    public string? LocalModelFile { get; init; }
    public string? LastValidationError { get; init; }
}
