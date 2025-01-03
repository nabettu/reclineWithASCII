import * as vscode from "vscode";
import * as path from "path";
import { listFiles } from "../../services/glob/list-files";
import { ClineProvider } from "../../core/webview/ClineProvider";

// Get workspace root path - used for relative path calculations
const workspaceRoot = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0);

interface WorkspaceUpdate {
  type: "workspaceUpdated";
  filePaths: string[];
}

/**
 * Tracks workspace file changes and maintains an up-to-date file list.
 * Handles file creation, deletion, and renaming events.
 */
class WorkspaceTracker {
  private readonly provider: ClineProvider;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly filePaths = new Set<string>();
  private readonly pendingUpdates = new Set<Promise<void>>();
  private updateDebounceTimeout?: NodeJS.Timeout;

  constructor(provider: ClineProvider) {
    this.provider = provider;
    this.registerListeners();
  }

  /**
   * Initialize the file path tracking system
   */
  public async initializeFilePaths(): Promise<void> {
    // Skip initialization if no workspace is selected
    if (!workspaceRoot) {
      return;
    }

    try {
      const [files, hasMore] = await listFiles(workspaceRoot, true, 1_000);

      if (hasMore) {
        console.warn("Workspace file listing truncated due to size limit");
      }

      // Process all files in batches to avoid blocking
      const batchSize = 100;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        await Promise.all(batch.map(file => this.addFilePath(file)));
      }

      await this.scheduleWorkspaceUpdate();
    } catch (error) {
      console.error("Failed to initialize file paths:", error);
      // Still attempt to register listeners even if initial scan fails
    }
  }

  /**
   * Register workspace file system event listeners
   */
  private registerListeners(): void {
    // Use arrow functions to preserve 'this' context
    this.disposables.push(
      vscode.workspace.onDidCreateFiles(e => this.onFilesCreated(e)),
      vscode.workspace.onDidDeleteFiles(e => this.onFilesDeleted(e)),
      vscode.workspace.onDidRenameFiles(e => this.onFilesRenamed(e))
    );
  }

  /**
   * Handle file creation events
   */
  private async onFilesCreated(event: vscode.FileCreateEvent): Promise<void> {
    const updates = event.files.map(file =>
      this.trackOperation(this.addFilePath(file.fsPath))
    );
    await this.handleFileOperations(updates);
  }

  /**
   * Handle file deletion events
   */
  private async onFilesDeleted(event: vscode.FileDeleteEvent): Promise<void> {
    const updates = event.files.map(file =>
      this.trackOperation(this.removeFilePath(file.fsPath))
    );
    await this.handleFileOperations(updates);
  }

  /**
   * Handle file rename events
   */
  private async onFilesRenamed(event: vscode.FileRenameEvent): Promise<void> {
    const updates = event.files.map(file =>
      this.trackOperation(
        Promise.all([
          this.removeFilePath(file.oldUri.fsPath),
          this.addFilePath(file.newUri.fsPath)
        ])
      ).then(() => undefined)
    );
    await this.handleFileOperations(updates);
  }

  /**
   * Track operation and add to pending updates
   */
  private trackOperation<T>(operation: Promise<T>): Promise<void> {
    const tracked = operation
      .then(() => undefined)
      .finally(() => {
        this.pendingUpdates.delete(tracked);
      });
    this.pendingUpdates.add(tracked);
    return tracked;
  }

  /**
   * Handle file operations and schedule workspace update
   */
  private async handleFileOperations(operations: Promise<void>[]): Promise<void> {
    try {
      await Promise.all(operations);
      await this.scheduleWorkspaceUpdate();
    } catch (error) {
      console.error("Error handling file operations:", error);
    }
  }

  /**
   * Schedule a debounced workspace update
   */
  private scheduleWorkspaceUpdate(): Promise<void> {
    return new Promise<void>(resolve => {
      if (this.updateDebounceTimeout) {
        clearTimeout(this.updateDebounceTimeout);
      }

      this.updateDebounceTimeout = setTimeout(async () => {
        // Wait for any pending operations to complete
        if (this.pendingUpdates.size > 0) {
          await Promise.all(this.pendingUpdates);
        }
        await this.workspaceDidUpdate();
        resolve();
      }, 100); // Debounce updates by 100ms
    });
  }

  /**
   * Notify webview of workspace updates
   */
  private async workspaceDidUpdate(): Promise<void> {
    if (!workspaceRoot) {
      return;
    }

    try {
      const update: WorkspaceUpdate = {
        type: "workspaceUpdated",
        filePaths: Array.from(this.filePaths).map(file => {
          const relativePath = path.relative(workspaceRoot, file);
          return this.ensureProperSlashes(relativePath);
        })
      };

      this.provider.postMessageToWebview(update);
    } catch (error) {
      console.error("Failed to send workspace update:", error);
    }
  }

  /**
   * Normalize file path with proper directory handling
   */
  private normalizeFilePath(filePath: string): string {
    if (!workspaceRoot) {
      return path.resolve(filePath);
    }

    // Ensure path is absolute and normalized
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspaceRoot, filePath);

    return path.normalize(absolutePath);
  }

  /**
   * Ensure proper slash handling for paths
   */
  private ensureProperSlashes(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    return normalized.endsWith("/") ? normalized : normalized;
  }

  /**
   * Add a file path to tracking
   */
  private async addFilePath(filePath: string): Promise<void> {
    const normalizedPath = this.normalizeFilePath(filePath);

    try {
      const uri = vscode.Uri.file(normalizedPath);
      const stat = await vscode.workspace.fs.stat(uri);
      const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;

      this.filePaths.add(
        isDirectory
          ? this.ensureProperSlashes(normalizedPath + "/")
          : this.ensureProperSlashes(normalizedPath)
      );
    } catch (error) {
      // Handle case where stat fails (e.g., for newly created files)
      this.filePaths.add(this.ensureProperSlashes(normalizedPath));
      console.warn(`Failed to stat path ${normalizedPath}:`, error);
    }
  }

  /**
   * Remove a file path from tracking
   */
  private async removeFilePath(filePath: string): Promise<void> {
    const normalizedPath = this.normalizeFilePath(filePath);
    const withSlash = this.ensureProperSlashes(normalizedPath + "/");
    const withoutSlash = this.ensureProperSlashes(normalizedPath);

    this.filePaths.delete(withSlash);
    this.filePaths.delete(withoutSlash);
  }

  /**
   * Clean up resources
   */
  public dispose(): void {
    if (this.updateDebounceTimeout) {
      clearTimeout(this.updateDebounceTimeout);
    }
    this.disposables.forEach(d => d.dispose());
    this.filePaths.clear();
    this.pendingUpdates.clear();
  }
}

export default WorkspaceTracker;
