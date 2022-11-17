import { z } from "zod";
import { Worker_Binding } from "../../runtime";
import { SERVICE_LOOPBACK } from "../core";
import {
  BINDING_SERVICE_LOOPBACK,
  BINDING_TEXT_PERSIST,
  BINDING_TEXT_PLUGIN,
  CfHeader,
  HEADER_PERSIST,
  PersistenceSchema,
  Plugin,
  encodePersist,
} from "../shared";
import { CacheGateway } from "./gateway";
import { CacheRouter } from "./router";

export const CacheOptionsSchema = z.object({});
export const CacheSharedOptionsSchema = z.object({
  cachePersist: PersistenceSchema,
  // Ideally, these options would be configurable per-worker (i.e. part of
  // `CacheOptionsSchema` instead). However, `workerd` can only have one global
  // "cache" service, so we can't distinguish which worker called the Cache API.
  cache: z.boolean().optional(),
  cacheWarnUsage: z.boolean().optional(),
});
export const CacheSharedOptionsSchema = z.object({
  cachePersist: PersistenceSchema,
});
export const CACHE_LOOPBACK_SCRIPT = `addEventListener("fetch", (event) => {
  let request = event.request;
  const url = new URL(request.url);
  url.pathname = \`/\${${BINDING_TEXT_PLUGIN}}/\${encodeURIComponent(request.url)}\`;
  if (globalThis.${BINDING_TEXT_PERSIST} !== undefined) {
    request = new Request(request);
    request.headers.set("${HEADER_PERSIST}", ${BINDING_TEXT_PERSIST});
  }
  event.respondWith(${BINDING_SERVICE_LOOPBACK}.fetch(url, request));
});`;
// Cache service script that doesn't do any caching
export const NOOP_CACHE_SCRIPT = `addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method === "GET") {
    event.respondWith(new Response(null, { status: 504, headers: { [${JSON.stringify(
      CfHeader.CacheStatus
    )}]: "MISS" } }));
  } else if (request.method === "PUT") {
    // Must consume request body, otherwise get "disconnected: read end of pipe was aborted" error from workerd
    event.respondWith(request.arrayBuffer().then(() => new Response(null, { status: 204 })));
  } else if (request.method === "PURGE") {
    event.respondWith(new Response(null, { status: 404 }));
  } else {
    event.respondWith(new Response(null, { status: 405 }));
  }
});`;
export const CACHE_PLUGIN_NAME = "cache";
export const CACHE_PLUGIN: Plugin<
  typeof CacheOptionsSchema,
  typeof CacheSharedOptionsSchema,
  CacheGateway
> = {
  gateway: CacheGateway,
  router: CacheRouter,
  options: CacheOptionsSchema,
  sharedOptions: CacheSharedOptionsSchema,
  getBindings() {
    return [];
  },
  getServices({ sharedOptions }) {
    const persistBinding = encodePersist(sharedOptions.cachePersist);
    const loopbackBinding: Worker_Binding = {
      name: BINDING_SERVICE_LOOPBACK,
      service: { name: SERVICE_LOOPBACK },
    };
    return [
      {
        name: "cache",
        worker: {
          serviceWorkerScript:
            // If options.cache is undefined, default to enabling cache
            sharedOptions.cache === false
              ? NOOP_CACHE_SCRIPT
              : CACHE_LOOPBACK_SCRIPT,
          bindings: [
            ...persistBinding,
            { name: BINDING_TEXT_PLUGIN, text: CACHE_PLUGIN_NAME },
            loopbackBinding,
          ],
          compatibilityDate: "2022-09-01",
        },
      },
    ];
  },
};

export * from "./gateway";
