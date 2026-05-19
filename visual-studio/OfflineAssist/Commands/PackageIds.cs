using System;

namespace OfflineAssist.Commands;

internal static class PackageGuids
{
    public const string OfflineAssistPackageString = "3D5E1B84-2A7F-4C8D-9E0F-1B2C3D4E5F60";
    public static readonly Guid OfflineAssistPackage = new(OfflineAssistPackageString);

    public const string OfflineAssistCmdSetString = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
    public static readonly Guid OfflineAssistCmdSet = new(OfflineAssistCmdSetString);
}

internal static class PackageIds
{
    public const int OpenChat               = 0x0100;
    public const int DownloadModel          = 0x0101;
    public const int RefreshModels          = 0x0102;
    public const int AddHuggingFaceModel    = 0x0103;
    public const int ListHuggingFaceImports = 0x0104;
    public const int RemoveHuggingFaceImport    = 0x0105;
    public const int ValidateHuggingFaceImports = 0x0106;
    public const int PrepareHuggingFaceImport   = 0x0107;
}
