import { FoundryLocalManager, type IModel } from 'foundry-local-sdk';
import type { IModelSource } from './modelSource.js';

/**
 * Model source implementation for Foundry Local SDK.
 */
export class FoundryModelSource implements IModelSource {
	readonly sourceId = 'foundry';
	readonly displayName = 'Foundry Local';

	private manager: FoundryLocalManager;
	private chatModelCache: IModel[] = [];
	private lastCacheTime = 0;
	private cacheValidityMs = 5 * 60 * 1000; // 5 minutes

	constructor(manager: FoundryLocalManager) {
		this.manager = manager;
	}

	async listChatModels(cancellationToken?: { isCancellationRequested: boolean }): Promise<IModel[]> {
		if (cancellationToken?.isCancellationRequested) {
			return [];
		}

		// Return cached results if still valid
		if (Date.now() - this.lastCacheTime < this.cacheValidityMs && this.chatModelCache.length > 0) {
			return this.chatModelCache;
		}

		const models = await this.manager.catalog.getModels();
		const chatModels = models
			.filter(model => this.isChatModel(model))
			.sort((left, right) =>
				(left.info.displayName ?? left.alias).localeCompare(right.info.displayName ?? right.alias),
			);

		this.chatModelCache = chatModels;
		this.lastCacheTime = Date.now();

		return chatModels;
	}

	async resolveModel(
		modelId: string,
		cancellationToken?: { isCancellationRequested: boolean },
	): Promise<IModel | undefined> {
		if (cancellationToken?.isCancellationRequested) {
			return undefined;
		}

		const models = await this.listChatModels(cancellationToken);
		return models.find(m => m.id === modelId);
	}

	async prepareModel(
		model: IModel,
		reporter: (message: string, percent?: number) => void,
		cancellationToken: { isCancellationRequested: boolean },
	): Promise<void> {
		if (cancellationToken.isCancellationRequested) {
			return;
		}

		// Register execution providers if needed
		reporter('Registering execution providers');
		await this.ensureExecutionProviders();

		if (cancellationToken.isCancellationRequested) {
			return;
		}

		// Download if not cached
		if (!model.isCached) {
			reporter('Downloading model');
			await model.download((percent: number) => {
				reporter(`Downloading model (${percent.toFixed(1)}%)`, percent);
			});
		}

		if (cancellationToken.isCancellationRequested) {
			return;
		}

		// Load into memory if not loaded
		if (!(await model.isLoaded())) {
			reporter('Loading model into memory');
			await model.load();
		}
	}

	async downloadModel(
		model: IModel,
		reporter: (message: string, percent?: number) => void,
		cancellationToken: { isCancellationRequested: boolean },
	): Promise<void> {
		if (cancellationToken.isCancellationRequested) {
			return;
		}

		if (!model.isCached) {
			reporter('Downloading model');
			await model.download((percent: number) => {
				reporter(`Downloading model (${percent.toFixed(1)}%)`, percent);
			});
		}
	}

	async refresh(): Promise<void> {
		// Invalidate cache to force refresh on next listChatModels call
		this.lastCacheTime = 0;
		this.chatModelCache = [];
	}

	/**
	 * Filters models to include only chat-capable ones.
	 */
	private isChatModel(model: IModel): boolean {
		const task = model.info.task?.toLowerCase() ?? '';
		if (task.includes('embedding') || task.includes('transcription') || task.includes('audio')) {
			return false;
		}

		// Ensure model supports text I/O
		const inputModalities = model.inputModalities?.toLowerCase() ?? '';
		const outputModalities = model.outputModalities?.toLowerCase() ?? '';
		if (!inputModalities.includes('text') || !outputModalities.includes('text')) {
			return false;
		}

		return true;
	}

	/**
	 * Ensures required execution providers are downloaded and registered.
	 */
	private async ensureExecutionProviders(): Promise<void> {
		try {
			await this.manager.downloadAndRegisterEps();
		} catch (error) {
			// Log but don't fail - execution providers may not be available on all platforms
			console.warn('Failed to ensure execution providers:', error);
		}
	}
}
