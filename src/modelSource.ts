import type { IModel } from 'foundry-local-sdk';

/**
 * Represents a source of AI models (e.g., Foundry Local, Hugging Face, Ollama).
 * Implementations handle discovery, lookup, preparation, and chat client creation for their models.
 */
export interface IModelSource {
	/**
	 * The identifier for this source (e.g., 'foundry', 'huggingface').
	 */
	readonly sourceId: string;

	/**
	 * The display name for this source in the UI.
	 */
	readonly displayName: string;

	/**
	 * Lists all chat-capable models available from this source.
	 * @param cancellationToken Optional token to cancel the operation.
	 * @returns Array of chat models.
	 */
	listChatModels(cancellationToken?: { isCancellationRequested: boolean }): Promise<IModel[]>;

	/**
	 * Resolves a model by its ID from this source.
	 * @param modelId The model ID to resolve.
	 * @param cancellationToken Optional token to cancel the operation.
	 * @returns The resolved model, or undefined if not found.
	 */
	resolveModel(modelId: string, cancellationToken?: { isCancellationRequested: boolean }): Promise<IModel | undefined>;

	/**
	 * Prepares a model for use (download, load, etc.).
	 * @param model The model to prepare.
	 * @param reporter Function to report progress.
	 * @param cancellationToken Token to cancel the operation.
	 */
	prepareModel(
		model: IModel,
		reporter: (message: string, percent?: number) => void,
		cancellationToken: { isCancellationRequested: boolean },
	): Promise<void>;

	/**
	 * Downloads a model from this source.
	 * @param model The model to download.
	 * @param reporter Function to report progress.
	 * @param cancellationToken Token to cancel the operation.
	 */
	downloadModel(
		model: IModel,
		reporter: (message: string, percent?: number) => void,
		cancellationToken: { isCancellationRequested: boolean },
	): Promise<void>;

	/**
	 * Called when models need to be refreshed (e.g., when user clicks refresh).
	 */
	refresh(): Promise<void>;
}

/**
 * Result of registering a model source.
 */
export interface ModelSourceRegistry {
	/**
	 * Get all registered model sources.
	 */
	getSources(): IModelSource[];

	/**
	 * Register a new model source.
	 * @param source The source to register.
	 */
	register(source: IModelSource): void;

	/**
	 * Unregister a model source by its ID.
	 * @param sourceId The source ID to unregister.
	 */
	unregister(sourceId: string): void;

	/**
	 * Get a source by its ID.
	 * @param sourceId The source ID.
	 * @returns The source, or undefined if not found.
	 */
	getSource(sourceId: string): IModelSource | undefined;

	/**
	 * List all models from all sources.
	 * @param cancellationToken Optional token to cancel the operation.
	 * @returns Combined array of models from all sources, sorted by display name.
	 */
	listAllModels(cancellationToken?: { isCancellationRequested: boolean }): Promise<IModel[]>;

	/**
	 * Resolve a model from any source by its ID.
	 * IDs should be namespaced with sourceId: prefix (e.g., 'foundry:model-id', 'hf:org/model').
	 * @param modelId The model ID (may include source prefix).
	 * @param cancellationToken Optional token to cancel the operation.
	 * @returns The resolved model with source info, or undefined if not found.
	 */
	resolveModel(modelId: string, cancellationToken?: { isCancellationRequested: boolean }): Promise<IModel | undefined>;
}
