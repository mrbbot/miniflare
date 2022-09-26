import { z } from "zod";
import { MiniflareError } from "../../helpers";
import { Worker_Binding } from "../../runtime";
import { getUserServiceName } from "../core";
import { PersistenceSchema, Plugin } from "../shared";
import { DurableObjectsStorageGateway } from "./gateway";
import { DurableObjectsStorageRouter } from "./router";

export type DurableObjectsErrorCode = "ERR_PERSIST_UNSUPPORTED"; // Durable Object persistence is not yet supported
export class DurableObjectsError extends MiniflareError<DurableObjectsErrorCode> {}

export const DurableObjectsOptionsSchema = z.object({
  durableObjects: z
    .record(
      z.union([
        z.string(),
        z.object({
          className: z.string(),
          scriptName: z.string().optional(),
        }),
      ])
    )
    .optional(),
});
export const DurableObjectsSharedOptionsSchema = z.object({
  durableObjectsPersist: PersistenceSchema,
});

export function normaliseDurableObject(
  klass: NonNullable<
    z.infer<typeof DurableObjectsOptionsSchema>["durableObjects"]
  >[string]
): [className: string, serviceName: string | undefined] {
  const isObject = typeof klass === "object";
  const className = isObject ? klass.className : klass;
  const serviceName =
    isObject && klass.scriptName !== undefined
      ? getUserServiceName(klass.scriptName)
      : undefined;
  return [className, serviceName];
}

export const DURABLE_OBJECTS_PLUGIN_NAME = "do";
export const DURABLE_OBJECTS_PLUGIN: Plugin<
  typeof DurableObjectsOptionsSchema,
  typeof DurableObjectsSharedOptionsSchema,
  DurableObjectsStorageGateway
> = {
  gateway: DurableObjectsStorageGateway,
  router: DurableObjectsStorageRouter,
  options: DurableObjectsOptionsSchema,
  sharedOptions: DurableObjectsSharedOptionsSchema,
  getBindings(options) {
    return Object.entries(options.durableObjects ?? {}).map<Worker_Binding>(
      ([name, klass]) => {
        const [className, serviceName] = normaliseDurableObject(klass);
        return {
          name,
          durableObjectNamespace: { className, serviceName },
        };
      }
    );
  },
  getServices({ options, sharedOptions }) {
    if (
      // If we have Durable Object bindings...
      Object.keys(options.durableObjects ?? {}).length > 0 &&
      // ...and persistence is enabled...
      sharedOptions.durableObjectsPersist
    ) {
      // ...throw, as Durable-Durable Objects are not yet supported
      throw new DurableObjectsError(
        "ERR_PERSIST_UNSUPPORTED",
        "Persisted Durable Objects are not yet supported"
      );
    }
  },
};

export * from "./gateway";
