using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace OfflineAssist.HuggingFace;

public sealed class HuggingFaceRuntimeService
{
    private readonly HttpClient _http = new();
    private const int MaxRetries = 2;

    public async Task<string> CompleteChatAsync(
        ImportedHuggingFaceModel model,
        IReadOnlyList<(string Role, string Content)> messages,
        CancellationToken cancellationToken)
    {
        return model.RuntimeBackend == HfRuntimeBackend.LocalLlamaCpp && model.LocalModelFile != null
            ? await CompleteLocalAsync(model.LocalModelFile, messages, cancellationToken)
            : await CompleteHostedAsync(model.RepoId, messages, cancellationToken);
    }

    private async Task<string> CompleteHostedAsync(
        string repoId,
        IReadOnlyList<(string Role, string Content)> messages,
        CancellationToken cancellationToken)
    {
        var endpointBase = "https://api-inference.huggingface.co/models";
        var prompt = MessagesToPrompt(messages);

        var payload = JsonConvert.SerializeObject(new
        {
            inputs = prompt,
            parameters = new { max_new_tokens = 512, temperature = 0.2, top_p = 1.0, return_full_text = false },
            options = new { wait_for_model = true, use_cache = false },
        });

        for (var attempt = 0; attempt <= MaxRetries; attempt++)
        {
            if (cancellationToken.IsCancellationRequested) return string.Empty;
            try
            {
                var request = new HttpRequestMessage(HttpMethod.Post, $"{endpointBase}/{Uri.EscapeDataString(repoId)}")
                {
                    Content = new StringContent(payload, Encoding.UTF8, "application/json"),
                };
                var response = await _http.SendAsync(request, cancellationToken);
                var body = await response.Content.ReadAsStringAsync();

                if (!response.IsSuccessStatusCode)
                    throw new HttpRequestException($"HF inference failed ({(int)response.StatusCode}): {body}");

                var arr = JArray.Parse(body);
                var text = string.Join("", arr.Select(item => item["generated_text"]?.Value<string>() ?? "")).Trim();
                if (!string.IsNullOrEmpty(text)) return text;

                throw new InvalidOperationException("HF inference returned no generated text.");
            }
            catch when (attempt < MaxRetries) { /* retry */ }
        }

        throw new InvalidOperationException("HF inference failed after retries.");
    }

    private async Task<string> CompleteLocalAsync(
        string modelFile,
        IReadOnlyList<(string Role, string Content)> messages,
        CancellationToken cancellationToken)
    {
        var prompt = MessagesToPrompt(messages);
        var args = $"-m \"{modelFile}\" -p \"{prompt.Replace("\"", "\\\"")}\" -n 512 --temp 0.2 --top-p 1";

        var psi = new ProcessStartInfo("llama-cli", args)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };

        using var proc = new Process { StartInfo = psi };
        var stdout = new StringBuilder();

        proc.OutputDataReceived += (_, e) => { if (e.Data != null) stdout.AppendLine(e.Data); };
        proc.Start();
        proc.BeginOutputReadLine();

        await Task.Run(() => proc.WaitForExit(), cancellationToken);

        if (proc.ExitCode != 0)
            throw new InvalidOperationException($"llama-cli exited with code {proc.ExitCode}.");

        var output = stdout.ToString().Trim();
        return output.StartsWith(prompt) ? output[prompt.Length..].Trim() : output;
    }

    private static string MessagesToPrompt(IReadOnlyList<(string Role, string Content)> messages)
    {
        var lines = messages.Select(m => $"{m.Role.ToUpperInvariant()}: {m.Content.Trim()}");
        return string.Join("\n\n", lines) + "\n\nASSISTANT:";
    }
}
