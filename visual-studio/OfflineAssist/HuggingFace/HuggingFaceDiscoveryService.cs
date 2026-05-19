using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace OfflineAssist.HuggingFace;

public sealed class HuggingFaceDiscoveryService
{
    private readonly HttpClient _http = new();

    public async Task<HuggingFaceModelDiscovery> DiscoverModelAsync(string input)
    {
        var repoId = NormalizeRepoId(input);
        var url = $"https://huggingface.co/api/models/{Uri.EscapeDataString(repoId)}";
        var json = await _http.GetStringAsync(url);
        var obj = JObject.Parse(json);

        if (obj["private"]?.Value<bool>() == true || obj["gated"]?.Value<bool>() == true)
            throw new InvalidOperationException($"'{repoId}' requires authentication.");

        var files = new List<HuggingFaceFile>();
        foreach (var sibling in obj["siblings"] ?? new JArray())
        {
            var path = sibling["rfilename"]?.Value<string>();
            if (!string.IsNullOrEmpty(path))
                files.Add(new HuggingFaceFile(path!, sibling["size"]?.Value<long?>()));
        }

        var tags = new List<string>();
        foreach (var tag in obj["tags"] ?? new JArray())
            tags.Add(tag.Value<string>()!);

        return new HuggingFaceModelDiscovery
        {
            RepoId = repoId,
            Revision = obj["sha"]?.Value<string>() ?? "main",
            DisplayName = DeriveDisplayName(repoId),
            Sha = obj["sha"]?.Value<string>(),
            License = obj["cardData"]?["license"]?.Value<string>(),
            Tags = tags,
            Files = files,
            PipelineTag = obj["pipeline_tag"]?.Value<string>(),
            Downloads = obj["downloads"]?.Value<long?>(),
            Likes = obj["likes"]?.Value<long?>(),
            LastModified = obj["lastModified"]?.Value<string>(),
        };
    }

    private static string NormalizeRepoId(string input)
    {
        var value = input.Trim()
            .Replace("https://huggingface.co/", "", StringComparison.OrdinalIgnoreCase)
            .Trim('/');
        if (string.IsNullOrEmpty(value) || !value.Contains('/'))
            throw new ArgumentException("Enter a Hugging Face repo id in 'owner/model' format.");
        return value;
    }

    private static string DeriveDisplayName(string repoId)
    {
        var idx = repoId.IndexOf('/');
        return idx >= 0 ? repoId[(idx + 1)..] : repoId;
    }
}
