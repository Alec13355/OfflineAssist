using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using OfflineAssist.HuggingFace;
using OfflineAssist.Models;

namespace OfflineAssist.Chat;

public partial class ChatWindowControl : UserControl, IDisposable
{
    private bool _webViewReady;
    private CancellationTokenSource? _cts;
    private readonly List<(string Role, string Content)> _history = [];
    private const int ToolStepLimit = 10;

    public ChatWindowControl()
    {
        InitializeComponent();
        Loaded += OnLoaded;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        await InitializeAsync();
    }

    public async Task InitializeAsync()
    {
        if (_webViewReady) return;

        var tempDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OfflineAssist", "WebView2Cache");
        Directory.CreateDirectory(tempDir);

        var env = await CoreWebView2Environment.CreateAsync(userDataFolder: tempDir);
        await WebView.EnsureCoreWebView2Async(env);

        WebView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        _webViewReady = true;
        StatusText.Visibility = Visibility.Collapsed;

        var html = LoadHtml();
        WebView.NavigateToString(html);
    }

    public async Task RefreshModelsAsync()
    {
        if (!_webViewReady) return;
        var models = await GetModelListAsync();
        PostMessage(new { type = "models", models });
    }

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var msg = JObject.Parse(e.WebMessageAsJson);
            var type = msg["type"]?.Value<string>();

            switch (type)
            {
                case "ready":
                    await RefreshModelsAsync();
                    break;

                case "send":
                    var text = msg["text"]?.Value<string>() ?? string.Empty;
                    var modelId = msg["modelId"]?.Value<string>() ?? string.Empty;
                    var mode = msg["mode"]?.Value<string>() ?? "plan";
                    if (!string.IsNullOrEmpty(text) && !string.IsNullOrEmpty(modelId))
                        await HandleSendAsync(modelId, mode, text);
                    break;

                case "cancel":
                    _cts?.Cancel();
                    break;

                case "clear":
                    _history.Clear();
                    break;
            }
        }
        catch { /* ignore malformed messages */ }
    }

    private async Task HandleSendAsync(string modelId, string mode, string text)
    {
        _cts?.Cancel();
        _cts = new CancellationTokenSource();
        var token = _cts.Token;

        _history.Add(("user", text));
        PostMessage(new { type = "start" });

        var responseText = string.Empty;
        try
        {
            if (mode == "plan")
            {
                await StreamFoundryAsync(modelId, BuildMessages(mode, _history), token,
                    chunk =>
                    {
                        responseText += chunk;
                        PostMessage(new { type = "chunk", text = chunk });
                    });
            }
            else
            {
                responseText = await RunAgentLoopAsync(modelId, mode, token);
            }

            _history.Add(("assistant", responseText));
        }
        catch (OperationCanceledException) { /* user cancelled */ }
        catch (Exception ex)
        {
            PostMessage(new { type = "error", message = ex.Message });
        }
        finally
        {
            PostMessage(new { type = "done" });
        }
    }

    private async Task<string> RunAgentLoopAsync(string modelId, string mode, CancellationToken token)
    {
        var messages = BuildMessages(mode, _history).ToList();
        var fullResponse = string.Empty;

        for (var step = 0; step < ToolStepLimit; step++)
        {
            token.ThrowIfCancellationRequested();

            var stepText = new StringBuilder();
            await StreamFoundryAsync(modelId, messages, token, chunk =>
            {
                stepText.Append(chunk);
                PostMessage(new { type = "chunk", text = chunk });
            });

            fullResponse = stepText.ToString();
            var toolCall = TryParseToolCall(fullResponse);

            if (toolCall == null) break;

            var result = await ExecuteToolAsync(toolCall, token);
            messages.Add(new { role = "assistant", content = fullResponse });
            messages.Add(new { role = "user", content = $"Tool result for {toolCall.Tool}:\n{result}\nIf done, give the final answer." });
        }

        return fullResponse;
    }

    private async Task StreamFoundryAsync(
        string modelId,
        IEnumerable<object> messages,
        CancellationToken token,
        Action<string> onChunk)
    {
        var pkg = OfflineAssistPackage.Instance!;

        var model = await pkg.Registry.ResolveModelAsync(modelId, token);
        if (model?.Source == "foundry")
        {
            await foreach (var chunk in pkg.FoundryClient.StreamChatAsync(modelId, messages.ToList(), token))
                onChunk(chunk);
            return;
        }

        if (model?.Source == "huggingface")
        {
            var hfModel = pkg.HfManifest.List().FirstOrDefault(m => m.RepoId == modelId);
            if (hfModel != null)
            {
                var histMessages = messages
                    .Select(m =>
                    {
                        var j = JObject.FromObject(m);
                        return (j["role"]!.Value<string>()!, j["content"]!.Value<string>()!);
                    }).ToList();

                var result = await pkg.HfRuntime.CompleteChatAsync(hfModel, histMessages, token);
                onChunk(result);
                return;
            }
        }

        throw new InvalidOperationException($"Model '{modelId}' not found.");
    }

    private static IEnumerable<object> BuildMessages(string mode, IEnumerable<(string Role, string Content)> history)
    {
        var system = mode switch
        {
            "agent" => "You are an agent with file tools. Respond with a ```tool``` block to call a tool, or plain text for final answers.",
            "yolo" => "You are an autonomous agent. Use tools freely to complete tasks. No confirmation needed.",
            _ => "You are a helpful coding assistant. Provide clear, accurate responses.",
        };

        yield return new { role = "system", content = system };
        foreach (var (role, content) in history)
            yield return new { role, content };
    }

    private record ToolCallRequest(string Tool, JObject Args);

    private static ToolCallRequest? TryParseToolCall(string response)
    {
        var block = System.Text.RegularExpressions.Regex.Match(response, @"```tool\s*([\s\S]*?)```", System.Text.RegularExpressions.RegexOptions.IgnoreCase).Groups[1].Value.Trim();
        if (string.IsNullOrEmpty(block))
            block = System.Text.RegularExpressions.Regex.Match(response, @"<tool_call>([\s\S]*?)</tool_call>", System.Text.RegularExpressions.RegexOptions.IgnoreCase).Groups[1].Value.Trim();
        if (string.IsNullOrEmpty(block)) return null;

        try
        {
            var obj = JObject.Parse(block);
            var tool = obj["tool"]?.Value<string>();
            if (string.IsNullOrEmpty(tool)) return null;
            return new ToolCallRequest(tool!, obj["args"] as JObject ?? []);
        }
        catch { return null; }
    }

    private static async Task<string> ExecuteToolAsync(ToolCallRequest call, CancellationToken token)
    {
        return call.Tool switch
        {
            "read_file" => ReadFile(call.Args),
            "list_files" => ListFiles(call.Args),
            "write_file" => await WriteFileAsync(call.Args),
            "replace_in_file" => await ReplaceInFileAsync(call.Args),
            _ => $"Unknown tool: {call.Tool}",
        };
    }

    private static string ReadFile(JObject args)
    {
        var path = args["path"]?.Value<string>() ?? throw new ArgumentException("path required");
        return File.Exists(path) ? File.ReadAllText(path) : $"File not found: {path}";
    }

    private static string ListFiles(JObject args)
    {
        var dir = args["path"]?.Value<string>() ?? ".";
        if (!Directory.Exists(dir)) return $"Directory not found: {dir}";
        var entries = Directory.GetFileSystemEntries(dir).Select(Path.GetFileName);
        return string.Join("\n", entries);
    }

    private static async Task<string> WriteFileAsync(JObject args)
    {
        var path = args["path"]?.Value<string>() ?? throw new ArgumentException("path required");
        var content = args["content"]?.Value<string>() ?? string.Empty;
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        await File.WriteAllTextAsync(path, content);
        return $"Wrote {content.Length} chars to {path}";
    }

    private static async Task<string> ReplaceInFileAsync(JObject args)
    {
        var path = args["path"]?.Value<string>() ?? throw new ArgumentException("path required");
        var search = args["search"]?.Value<string>() ?? throw new ArgumentException("search required");
        var replace = args["replace"]?.Value<string>() ?? string.Empty;
        if (!File.Exists(path)) return $"File not found: {path}";
        var original = await File.ReadAllTextAsync(path);
        var updated = original.Replace(search, replace, StringComparison.Ordinal);
        await File.WriteAllTextAsync(path, updated);
        return updated == original ? "No match found." : $"Replaced in {path}";
    }

    private async Task<IReadOnlyList<object>> GetModelListAsync()
    {
        var pkg = OfflineAssistPackage.Instance!;
        var models = await pkg.Registry.ListAllModelsAsync();
        var hfModels = pkg.HfManifest.List()
            .Where(m => m.Status == ImportedModelStatus.Ready)
            .Select(m => (object)new
            {
                id = m.RepoId,
                name = m.DisplayName,
                isCached = true,
                sizeMb = (long?)null,
                supportsToolCalling = m.RuntimeBackend == HfRuntimeBackend.LocalLlamaCpp,
                backend = m.RuntimeBackend?.ToString() ?? "hf-hosted",
                runtimeStatus = "ready",
            });

        return models.Select(m => (object)new
        {
            id = m.Id,
            name = m.DisplayName,
            isCached = m.IsCached,
            sizeMb = m.SizeMb,
            supportsToolCalling = m.SupportsToolCalling,
            backend = m.Backend ?? "foundry",
            runtimeStatus = m.RuntimeStatus ?? "unknown",
        }).Concat(hfModels).ToList();
    }

    private void PostMessage(object payload)
    {
        if (!_webViewReady) return;
        var json = JsonConvert.SerializeObject(payload);
        Dispatcher.InvokeAsync(() => WebView.CoreWebView2?.PostWebMessageAsJson(json));
    }

    private static string LoadHtml()
    {
        var asm = Assembly.GetExecutingAssembly();
        using var stream = asm.GetManifestResourceStream("OfflineAssist.Chat.ChatPanel.html")
            ?? throw new InvalidOperationException("ChatPanel.html not found as embedded resource.");
        return new StreamReader(stream).ReadToEnd();
    }

    public void Dispose()
    {
        _cts?.Cancel();
        _cts?.Dispose();
    }
}
