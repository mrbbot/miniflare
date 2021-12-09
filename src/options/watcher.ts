import path from "path";
import chokidar from "chokidar";
import { Log } from "../log";
import { OptionsProcessor } from "./processor";
import { Options, ProcessedOptions, logOptions } from "./index";

function pathSetToString(set: Set<string>): string {
  return [...set]
    .map((filePath) => path.relative("", filePath))
    .sort()
    .join(", ");
}

export type OptionsWatchCallback = (
  options: ProcessedOptions
) => void | Promise<void>;

export class OptionsWatcher {
  private _processor: OptionsProcessor;
  private _options?: ProcessedOptions;

  private _watcher?: chokidar.FSWatcher;
  private _watchedPaths?: Set<string>;
  private _extraWatchedPaths?: Set<string>;
  private _building = false;

  readonly initPromise: Promise<void>;

  constructor(
    private log: Log,
    private callback: OptionsWatchCallback,
    private initialOptions: Options,
    private watchOptions?: chokidar.WatchOptions
  ) {
    this._processor = new OptionsProcessor(log, initialOptions);

    // Setup initial options
    this.initPromise = this._init();
  }

  private _getWatchedPaths(): Set<string> {
    const watchedPaths = new Set<string>(this._extraWatchedPaths);
    watchedPaths.add(this._processor.wranglerConfigPath);
    watchedPaths.add(this._processor.packagePath);
    if (this._options?.envPath) watchedPaths.add(this._options.envPath);
    if (this._options?.buildWatchPath)
      watchedPaths.add(this._options.buildWatchPath);
    if (this._options?.scriptPath) watchedPaths.add(this._options.scriptPath);
    for (const durableObject of this._options?.processedDurableObjects ?? []) {
      if (durableObject.scriptPath) watchedPaths.add(durableObject.scriptPath);
    }
    for (const wasmPath of Object.values(this._options?.wasmBindings ?? {})) {
      watchedPaths.add(wasmPath);
    }
    return watchedPaths;
  }

  private _updateWatchedPaths(): void {
    // Update watched paths only if we're watching files
    if (this._watcher && this._watchedPaths) {
      // Store changed paths for logging
      const unwatchedPaths = new Set<string>();
      const watchedPaths = new Set<string>();

      const newWatchedPaths = this._getWatchedPaths();
      // Unwatch paths that should no longer be watched
      for (const watchedPath of this._watchedPaths) {
        if (!newWatchedPaths.has(watchedPath)) {
          unwatchedPaths.add(watchedPath);
          this._watcher.unwatch(watchedPath);
        }
      }
      // Watch paths that should now be watched
      for (const newWatchedPath of newWatchedPaths) {
        if (!this._watchedPaths.has(newWatchedPath)) {
          watchedPaths.add(newWatchedPath);
          this._watcher.add(newWatchedPath);
        }
      }
      this._watchedPaths = newWatchedPaths;

      if (unwatchedPaths.size > 0) {
        this.log.debug(`Unwatching ${pathSetToString(unwatchedPaths)}...`);
      }
      if (watchedPaths.size > 0) {
        this.log.debug(`Watching ${pathSetToString(watchedPaths)}...`);
      }
    }
  }

  setExtraWatchedPaths(paths?: Set<string>): void {
    this._extraWatchedPaths = paths;
    this._updateWatchedPaths();
  }

  private async _init(): Promise<void> {
    // Yield initial values
    this._options = await this._processor.getProcessedOptions(true);
    logOptions(this.log, this._options);
    await this.callback(this._options);

    // Stop here if we're not watching files
    if (!this._options?.watch) return;

    // Get an array of watched file paths, storing them so we can tell if they
    // change later
    this._watchedPaths = this._getWatchedPaths();
    this.log.debug(`Watching ${pathSetToString(this._watchedPaths)}...`);

    // Create watcher
    const boundCallback = this._watchedPathCallback.bind(this);
    this._watcher = chokidar
      .watch([...this._watchedPaths], {
        ...this.watchOptions,
        awaitWriteFinish: {
          stabilityThreshold: 100
        },
        ignoreInitial: true,
      })
      .on("add", boundCallback)
      .on("change", boundCallback)
      .on("unlink", boundCallback);
  }

  private async _watchedPathCallback(eventPath: string) {
    if (
      this._options?.buildWatchPath &&
      eventPath.startsWith(this._options.buildWatchPath)
    ) {
      if (this._options.buildCommand) {
        this.log.debug(
          `${path.relative("", eventPath)} changed, rebuilding...`
        );
        // Re-run build, this should change a script triggering the watcher
        // again
        this._building = true;
        try {
          const succeeded = await this._processor.runCustomBuild(
            this._options.buildCommand,
            this._options.buildBasePath
          );
          if (succeeded) await this.reloadOptions(false);
        } finally {
          // Wait a little bit before starting to process watch events again
          // to allow built file changes to come through
          setTimeout(() => (this._building = false), 50);
        }
      }
    } else if (!this._building) {
      // If the path isn't in buildWatchPath, reload options and scripts,
      // provided we're not currently building
      this.log.debug(`${path.relative("", eventPath)} changed, reloading...`);

      // Log options is this was an options file, we don't want to spam the log
      // with script changes
      const log =
        eventPath === this._processor.wranglerConfigPath ||
        eventPath === this._processor.packagePath ||
        eventPath === this._options?.envPath;

      await this.reloadOptions(log);
    }
  }

  async reloadOptions(log = true): Promise<void> {
    this._options = await this._processor.getProcessedOptions();
    if (log) logOptions(this.log, this._options);
    this._updateWatchedPaths();
    await this.callback(this._options);
  }

  async dispose(): Promise<void> {
    await this._watcher?.close();
  }
}
