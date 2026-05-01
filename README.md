# Offline Assist 

Offline Assist is a standalone VS Code extension that exposes Foundry Local chat-capable models through VS Code's language model picker.

What it does:

- Lists chat-capable models from the local Foundry catalog.
- Registers them as a `languageModelChatProvider` vendor named `offline-assist`.
- Downloads and loads a selected model lazily the first time you send a chat request.
- Adds an `OfflineAssist: Download Chat Model` command so you can pre-download a model before chatting.

## Requirements

- VS Code Insiders.
- Proposed API access for `chatProvider@4`.
- Foundry Local installed on your machine.
- Node.js 18+.

Install Foundry Local on macOS:

```bash
brew install microsoft/foundrylocal/foundrylocal
```

## Run

```bash
cd Offline-Assist
npm install
npm run compile
```

Then open this folder in VS Code Insiders and launch an Extension Development Host.

## Use the Extension

1. Open the chat view in the Extension Development Host.
2. Open the model picker.
3. Choose a model under `Offline Assist`.
4. Send a prompt. The extension will download execution providers if needed, then download and load the model on first use.

Optional command:

- `OfflineAssist: Download Chat Model` pre-downloads a model from a quick pick.

## Notes

- This project intentionally handles text chat only.
- It does not yet bridge VS Code tool-calling to Foundry Local tool-calling.
- Non-chat models such as transcription and embeddings are filtered out of the picker.