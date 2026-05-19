using System.Collections.Generic;

namespace OfflineAssist.HuggingFace;

public sealed class HuggingFaceCompatibilityService
{
    private static readonly HashSet<string> SupportedTags =
        ["text-generation", "conversational", "text2text-generation"];

    private static readonly HashSet<string> UnsupportedTags =
        ["automatic-speech-recognition", "feature-extraction", "image-classification",
         "image-to-text", "object-detection", "text-to-image", "audio-classification"];

    public HuggingFaceCompatibilityResult Assess(HuggingFaceModelDiscovery model)
    {
        var pipeline = model.PipelineTag?.ToLowerInvariant();

        if (pipeline != null && UnsupportedTags.Contains(pipeline))
            return new(HuggingFaceCompatibility.Unsupported,
                $"Pipeline '{pipeline}' is not a chat/text-generation workload.", []);

        var tags = new HashSet<string>();
        foreach (var t in model.Tags) tags.Add(t.ToLowerInvariant());

        if (pipeline != null && SupportedTags.Contains(pipeline))
        {
            if (tags.Contains("gguf") || tags.Contains("onnx"))
            {
                var hints = new List<string>();
                if (tags.Contains("gguf")) hints.Add("gguf");
                if (tags.Contains("onnx")) hints.Add("onnx");
                return new(HuggingFaceCompatibility.Direct,
                    "Model exposes a runtime-friendly format for local inference.", hints);
            }

            if (tags.Contains("safetensors") || tags.Contains("transformers"))
            {
                var hints = new List<string>();
                if (tags.Contains("safetensors")) hints.Add("safetensors");
                if (tags.Contains("transformers")) hints.Add("transformers");
                return new(HuggingFaceCompatibility.Convertible,
                    "Model needs conversion/quantization before local runtime execution.", hints);
            }

            return new(HuggingFaceCompatibility.Convertible,
                "Text model detected; runtime artifacts not explicit — conversion likely required.", []);
        }

        return new(HuggingFaceCompatibility.Convertible,
            "Insufficient metadata for direct execution; treat as conversion candidate.", []);
    }
}
