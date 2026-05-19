import type { IModel } from 'foundry-local-sdk';
import type { IModelSource, ModelSourceRegistry } from './modelSource.js';

/**
 * Manages a collection of model sources and provides unified access to models from all sources.
 */
export class DefaultModelSourceRegistry implements ModelSourceRegistry {
	private sources: Map<string, IModelSource> = new Map();
	private modelCache: Map<string, IModel> = new Map();
	private cacheValidityMs = 5 * 60 * 1000; // 5 minutes
	private lastCacheTime = 0;

	getSources(): IModelSource[] {
		return Array.from(this.sources.values());
	}

	register(source: IModelSource): void {
		if (this.sources.has(source.sourceId)) {
			throw new Error(`Model source with ID '${source.sourceId}' is already registered.`);
		}
		this.sources.set(source.sourceId, source);
		this.invalidateCache();
	}

	unregister(sourceId: string): void {
		if (this.sources.delete(sourceId)) {
			this.invalidateCache();
		}
	}

	getSource(sourceId: string): IModelSource | undefined {
		return this.sources.get(sourceId);
	}

	async listAllModels(cancellationToken?: { isCancellationRequested: boolean }): Promise<IModel[]> {
		if (cancellationToken?.isCancellationRequested) {
			return [];
		}

		// Return cached results if still valid
		if (Date.now() - this.lastCacheTime < this.cacheValidityMs && this.modelCache.size > 0) {
			return Array.from(this.modelCache.values());
		}

		const allModels: IModel[] = [];
		const modelMap = new Map<string, IModel>();

		// Collect models from all sources
		for (const source of this.sources.values()) {
			try {
				const sourceModels = await source.listChatModels(cancellationToken);
				for (const model of sourceModels) {
					const namespacedId = this.getNamespacedId(source.sourceId, model.id);
					modelMap.set(namespacedId, model);
					allModels.push(model);
				}
			} catch (error) {
				console.warn(`Failed to list models from source '${source.sourceId}':`, error);
			}
		}

		// Sort by display name
		allModels.sort((a, b) =>
			(a.info.displayName ?? a.alias).localeCompare(b.info.displayName ?? b.alias),
		);

		// Cache results
		this.modelCache = modelMap;
		this.lastCacheTime = Date.now();

		return allModels;
	}

	async resolveModel(
		modelId: string,
		cancellationToken?: { isCancellationRequested: boolean },
	): Promise<IModel | undefined> {
		if (cancellationToken?.isCancellationRequested) {
			return undefined;
		}

		// Check cache first
		if (this.modelCache.has(modelId)) {
			return this.modelCache.get(modelId);
		}

		// Parse source prefix if present (format: 'sourceId:modelId')
		const [sourceId, actualModelId] = this.parseNamespacedId(modelId);

		if (sourceId) {
			// If source ID is specified, query only that source
			const source = this.sources.get(sourceId);
			if (source) {
				const model = await source.resolveModel(actualModelId, cancellationToken);
				if (model) {
					return model;
				}
			}
			return undefined;
		}

		// Otherwise, search all sources
		for (const source of this.sources.values()) {
			try {
				const model = await source.resolveModel(modelId, cancellationToken);
				if (model) {
					return model;
				}
			} catch (error) {
				// Continue searching other sources
			}
		}

		return undefined;
	}

	private invalidateCache(): void {
		this.modelCache.clear();
		this.lastCacheTime = 0;
	}

	/**
	 * Creates a namespaced model ID to avoid collisions between sources.
	 * Format: 'sourceId:modelId'
	 */
	private getNamespacedId(sourceId: string, modelId: string): string {
		return `${sourceId}:${modelId}`;
	}

	/**
	 * Parses a namespaced model ID back into source and model components.
	 * Returns [sourceId, modelId] where sourceId is empty string if not namespaced.
	 */
	private parseNamespacedId(modelId: string): [sourceId: string, modelId: string] {
		const colonIndex = modelId.indexOf(':');
		if (colonIndex > 0) {
			return [modelId.substring(0, colonIndex), modelId.substring(colonIndex + 1)];
		}
		return ['', modelId];
	}
}
