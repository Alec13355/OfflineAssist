import * as vscode from 'vscode';
import type { HuggingFaceCompatibility } from './huggingFaceCompatibility.js';

export type ImportedModelStatus = 'discovered' | 'validated' | 'importing' | 'ready' | 'error';

export interface ImportedHuggingFaceModel {
	repoId: string;
	revision: string;
	displayName: string;
	addedAt: string;
	status: ImportedModelStatus;
	compatibility?: HuggingFaceCompatibility;
	compatibilityReason?: string;
	runtimeHints?: string[];
	runtimeBackend?: 'local-llama-cpp' | 'hf-hosted';
	license?: string;
	pipelineTag?: string;
	tags: string[];
	files?: Array<{ path: string; size?: number }>;
	localArtifactPath?: string;
	localModelFile?: string;
	lastValidationError?: string;
}

const manifestStateKey = 'offlineAssist.huggingFaceImports';

export class HuggingFaceImportManifest {
	constructor(private readonly globalState: vscode.Memento) {}

	public list(): ImportedHuggingFaceModel[] {
		const items = this.globalState.get<ImportedHuggingFaceModel[]>(manifestStateKey, []);
		return [...items].sort((a, b) => a.repoId.localeCompare(b.repoId));
	}

	public async upsert(model: ImportedHuggingFaceModel): Promise<void> {
		const items = this.list();
		const existingIndex = items.findIndex(item => item.repoId === model.repoId);
		if (existingIndex >= 0) {
			items[existingIndex] = model;
		} else {
			items.push(model);
		}
		await this.globalState.update(manifestStateKey, items);
	}

	public async remove(repoId: string): Promise<boolean> {
		const items = this.list();
		const next = items.filter(item => item.repoId !== repoId);
		const changed = next.length !== items.length;
		if (changed) {
			await this.globalState.update(manifestStateKey, next);
		}
		return changed;
	}

	public async clear(): Promise<void> {
		await this.globalState.update(manifestStateKey, []);
	}
}
