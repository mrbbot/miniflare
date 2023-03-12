import {
  CorePluginSignatures,
  MiniflareCore,
  ReloadEvent,
  logResponse,
} from "@miniflare/core";
import { Cron } from "croner";
import { SchedulerPlugin } from "./plugin";

export * from "./plugin";

export type SchedulerPluginSignatures = CorePluginSignatures & {
  SchedulerPlugin: typeof SchedulerPlugin;
};

const kReload = Symbol("kReload");

export class CronScheduler<Plugins extends SchedulerPluginSignatures> {
  // noinspection JSMismatchedCollectionQueryUpdate
  private previousValidatedCrons?: string[];
  private scheduledHandles?: Cron[];
  private inaccurateCpu?: boolean;

  constructor(
    private readonly mf: MiniflareCore<Plugins>
  ) {
    mf.addEventListener("reload", this[kReload]);
  }

  [kReload] = async (event: ReloadEvent<Plugins>): Promise<void> => {
    const validatedCrons = event.plugins.SchedulerPlugin.validatedCrons;
    this.inaccurateCpu = event.plugins.CorePlugin.inaccurateCpu;
    // Checking references here, if different, SchedulerPlugin setup must've
    // been called meaning crons changed so reload scheduled tasks
    if (this.previousValidatedCrons === validatedCrons) return;
    this.previousValidatedCrons = validatedCrons;

    // Schedule tasks, stopping all current ones first
    this.scheduledHandles?.forEach((handle) =>
      handle.stop()
    );
    if (!validatedCrons.length) return;

    this.scheduledHandles = validatedCrons?.map((cron) => {
      const spec = cron.toString();
      return Cron(spec, async () => {
        const start = process.hrtime();
        const startCpu = this.inaccurateCpu ? process.cpuUsage() : undefined;
        // scheduledTime will default to Date.now()
        const waitUntil = this.mf.dispatchScheduled(undefined, spec);
        await logResponse(this.mf.log, {
          start,
          startCpu,
          method: "SCHD",
          url: spec,
          waitUntil,
        });
      });
    });
  };

  async dispose(): Promise<void> {
    this.mf.removeEventListener("reload", this[kReload]);
    this.scheduledHandles?.forEach((handle) =>
      handle.stop()
    );
  }
}

export async function startScheduler<Plugins extends SchedulerPluginSignatures>(
  mf: MiniflareCore<Plugins>
): Promise<CronScheduler<Plugins>> {
  const scheduler = new CronScheduler(mf);
  const reloadEvent = new ReloadEvent("reload", {
    plugins: await mf.getPlugins(),
    initial: false,
  });
  await scheduler[kReload](reloadEvent);
  return scheduler;
}
