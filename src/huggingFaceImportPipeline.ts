import * as vscode from 'vscode';
import type { ImportedHuggingFaceModel } from './huggingFaceManifest.js';

export class HuggingFaceImportPipeline {
	public constructor(
		private readonly outputChannel: vscode.OutputChannel,
		private readonly globalStorageUri: vscode.Uri,
	) {}

	public async prepareModel(model: ImportedHuggingFaceModel): Promise<ImportedHuggingFaceModel> {
		const safeName = model.repoId.replace(/[^a-zA-Z0-9._-]+/g, '__');
		const modelFolder = vscode.Uri.joinPath(this.globalStorageUri, 'huggingface-models', safeName);
		await vscode.workspace.fs.createDirectory(modelFolder);

		let runtimeBackend: ImportedHuggingFaceModel['runtimeBackend'] = 'hf-hosted';
		let localModelFile: string | undefined;

		const ggufCandidates = (model.files ?? [])
			.filter(file => file.path.toLowerCase().endsWith('.gguf'))
			.sort((left, right) => {
				const leftSize = left.size ?? Number.MAX_SAFE_INTEGER;
				const rightSize = right.size ?? Number.MAX_SAFE_INTEGER;
				return leftSize - rightSize;
			});

		if (ggufCandidates.length > 0 && model.compatibility === 'direct') {
			const preferred = this.pickPreferredGguf(ggufCandidates);
			const fileName = preferred.path.split('/').pop() || 'model.gguf';
			const destination = vscode.Uri.joinPath(modelFolder, fileName);
			await this.downloadModelFile(model.repoId, model.revision, preferred.path, destination);
			runtimeBackend = 'local-llama-cpp';
			localModelFile = destination.fsPath;
		}

		const metadataPath = vscode.Uri.joinPath(modelFolder, 'metadata.json');
		const metadata = {
			repoId: model.repoId,
			revision: model.revision,
			compatibility: model.compatibility,
			compatibilityReason: model.compatibilityReason,
			tags: model.tags,
			runtimeBackend,
			localModelFile,
			preparedAt: new Date().toISOString(),
		};
		await vscode.workspace.fs.writeFile(metadataPath, new TextEncoder().encode(JSON.stringify(metadata, null, 2)));

		this.outputChannel.appendLine(`[hf] Prepared local metadata at ${metadataPath.fsPath}`);

		return {
			...model,
			status: 'ready',
			runtimeBackend,
			localArtifactPath: modelFolder.fsPath,
			localModelFile,
			lastValidationError: undefined,
		};
	}

	private pickPreferredGguf(files: Array<{ path: string; size?: number }>): { path: string; size?: number } {
		const qualityHints = ['q4_k_m', 'q4_k_s', 'q5_k_m', 'q6_k'];
		for (const hint of qualityHints) {
			const matched = files.find(file => file.path.toLowerCase().includes(hint));
			if (matched) {
				return matched;
			}
		}

		return files[0];
	}

	private async downloadModelFile(repoId: string, revision: string, modelPath: string, destination: vscode.Uri): Promise<void> {
		const encodedPath = modelPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
		const encodedRevision = encodeURIComponent(revision);
		const url = `https://huggingface.co/${repoId}/resolve/${encodedRevision}/${encodedPath}`;
		this.outputChannel.appendLine(`[hf] Downloading ${modelPath} from ${repoId}@${revision}`);

		const response = await fetch(url);
		if (!response.ok || !response.body) {
			throw new Error(`Failed to download '${modelPath}' (${response.status} ${response.statusText}).`);
		}

		const chunks: Uint8Array[] = [];
		const reader = response.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value) {
				chunks.push(value);
			}
		}

		const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
		const merged = new Uint8Array(totalSize);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}

		await vscode.workspace.fs.writeFile(destination, merged);
		this.outputChannel.appendLine(`[hf] Saved local model file: ${destination.fsPath}`);
	}

	public async removeModelArtifacts(model: ImportedHuggingFaceModel): Promise<void> {
		if (!model.localArtifactPath) {
			return;
		}

		const modelUri = vscode.Uri.file(model.localArtifactPath);
		try {
			await vscode.workspace.fs.delete(modelUri, { recursive: true, useTrash: false });
			this.outputChannel.appendLine(`[hf] Deleted artifacts for ${model.repoId}: ${model.localArtifactPath}`);
		} catch (error) {
			this.outputChannel.appendLine(`[hf] Failed to delete artifacts for ${model.repoId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
