using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace OfflineAssist.Models;

public sealed class FoundryLocalClient : IDisposable
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(30) };
    private string? _serviceEndpoint;

    private static readonly string[] DefaultEndpoints =
    [
        "http://localhost:5273",
        "http://127.0.0.1:5273",
    ];

    public async Task<string?> DetectEndpointAsync(CancellationToken cancellationToken = default)
    {
        foreach (var candidate in DefaultEndpoints)
        {
            try
            {
                var resp = await _http.GetAsync($"{candidate}/openai/v1/models", cancellationToken);
                if (resp.IsSuccessStatusCode)
                {
                    _serviceEndpoint = candidate;
                    return candidate;
                }
            }
            catch { /* try next */ }
        }
        return null;
    }

    public async Task EnsureServiceRunningAsync(CancellationToken cancellationToken = default)
    {
        if (_serviceEndpoint != null) return;
        if (await DetectEndpointAsync(cancellationToken) != null) return;

        var psi = new ProcessStartInfo("foundry", "service start")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        Process.Start(psi);

        for (var i = 0; i < 20; i++)
        {
            await Task.Delay(500, cancellationToken);
            if (await DetectEndpointAsync(cancellationToken) != null) return;
        }

        throw new InvalidOperationException(
            "Foundry Local service did not start. Run 'foundry service start' manually.");
    }

    public async Task<IReadOnlyList<FoundryModel>> ListModelsAsync(CancellationToken cancellationToken = default)
    {
        await EnsureServiceRunningAsync(cancellationToken);
        var url = $"{_serviceEndpoint}/openai/v1/models";
        var json = await _http.GetStringAsync(url, cancellationToken);
        var root = JObject.Parse(json);
        var results = new List<FoundryModel>();

        foreach (var item in root["data"] ?? new JArray())
        {
            results.Add(new FoundryModel
            {
                Id = item["id"]?.Value<string>() ?? string.Empty,
                Object = item["object"]?.Value<string>() ?? "model",
                IsCached = item["is_cached"]?.Value<bool>() ?? false,
                IsLoaded = item["is_loaded"]?.Value<bool>() ?? false,
                SizeMb = item["size_mb"]?.Value<long?>(),
                SupportsToolCalling = item["supports_tool_calling"]?.Value<bool>() ?? false,
            });
        }

        return results;
    }

    public async IAsyncEnumerable<string> StreamChatAsync(
        string modelId,
        IReadOnlyList<object> messages,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await EnsureServiceRunningAsync(cancellationToken);

        var payload = JsonConvert.SerializeObject(new
        {
            model = modelId,
            messages,
            stream = true,
        });

        var request = new HttpRequestMessage(HttpMethod.Post, $"{_serviceEndpoint}/openai/v1/chat/completions")
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json"),
        };

        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();

        using var stream = await response.Content.ReadAsStreamAsync();
        using var reader = new System.IO.StreamReader(stream);

        while (!reader.EndOfStream && !cancellationToken.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync();
            if (string.IsNullOrWhiteSpace(line) || !line.StartsWith("data: ")) continue;
            var data = line["data: ".Length..];
            if (data == "[DONE]") break;

            var chunk = JObject.Parse(data);
            var delta = chunk["choices"]?[0]?["delta"]?["content"]?.Value<string>();
            if (!string.IsNullOrEmpty(delta))
                yield return delta;
        }
    }

    public async Task DownloadModelAsync(string modelId, Action<string> progress, CancellationToken cancellationToken)
    {
        var psi = new ProcessStartInfo("foundry", $"model download {modelId}")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };

        using var proc = new Process { StartInfo = psi };
        proc.OutputDataReceived += (_, e) => { if (e.Data != null) progress(e.Data); };
        proc.ErrorDataReceived += (_, e) => { if (e.Data != null) progress(e.Data); };
        proc.Start();
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();

        await Task.Run(() => proc.WaitForExit(), cancellationToken);
        if (proc.ExitCode != 0)
            throw new InvalidOperationException($"foundry model download exited with code {proc.ExitCode}.");
    }

    public void Dispose() => _http.Dispose();
}

public sealed class FoundryModel
{
    public string Id { get; init; } = string.Empty;
    public string Object { get; init; } = "model";
    public bool IsCached { get; init; }
    public bool IsLoaded { get; init; }
    public long? SizeMb { get; init; }
    public bool SupportsToolCalling { get; init; }
}
