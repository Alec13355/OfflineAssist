using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;

namespace OfflineAssist.HuggingFace;

public sealed class HuggingFaceManifest
{
    private readonly string _filePath;
    private List<ImportedHuggingFaceModel> _items;

    public HuggingFaceManifest(string storageRoot)
    {
        _filePath = Path.Combine(storageRoot, "hf-manifest.json");
        _items = Load();
    }

    public IReadOnlyList<ImportedHuggingFaceModel> List() =>
        _items.OrderBy(m => m.RepoId).ToList();

    public void Upsert(ImportedHuggingFaceModel model)
    {
        var idx = _items.FindIndex(m => m.RepoId == model.RepoId);
        if (idx >= 0) _items[idx] = model;
        else _items.Add(model);
        Save();
    }

    public bool Remove(string repoId)
    {
        var before = _items.Count;
        _items = _items.Where(m => m.RepoId != repoId).ToList();
        if (_items.Count == before) return false;
        Save();
        return true;
    }

    public void Clear()
    {
        _items.Clear();
        Save();
    }

    private List<ImportedHuggingFaceModel> Load()
    {
        if (!File.Exists(_filePath)) return [];
        var json = File.ReadAllText(_filePath);
        return JsonConvert.DeserializeObject<List<ImportedHuggingFaceModel>>(json) ?? [];
    }

    private void Save() =>
        File.WriteAllText(_filePath, JsonConvert.SerializeObject(_items, Formatting.Indented));
}
