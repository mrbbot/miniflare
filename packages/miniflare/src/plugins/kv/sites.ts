import assert from "assert";
import fs from "fs/promises";
import path from "path";
import { Request } from "../../http";
import { Service, Worker_Binding, Worker_Module } from "../../runtime";
import {
  MatcherRegExps,
  base64Decode,
  base64Encode,
  deserialiseRegExps,
  globsToRegExps,
  lexicographicCompare,
  serialiseRegExps,
  testRegExps,
} from "../../shared";
import { createFileReadableStream } from "../../storage";
import { CoreBindings } from "../../workers";
import {
  BINDING_TEXT_PERSIST,
  HEADER_PERSIST,
  Persistence,
  WORKER_BINDING_SERVICE_LOOPBACK,
  kProxyNodeBinding,
} from "../shared";
import { HEADER_SITES, KV_PLUGIN_NAME, MAX_LIST_KEYS } from "./constants";
import {
  KVGatewayGetOptions,
  KVGatewayGetResult,
  KVGatewayListOptions,
  KVGatewayListResult,
  validateGetOptions,
  validateListOptions,
} from "./gateway";

async function* listKeysInDirectoryInner(
  rootPath: string,
  currentPath: string
): AsyncGenerator<string> {
  const fileEntries = await fs.readdir(currentPath, { withFileTypes: true });
  for (const fileEntry of fileEntries) {
    const filePath = path.posix.join(currentPath, fileEntry.name);
    if (fileEntry.isDirectory()) {
      yield* listKeysInDirectoryInner(rootPath, filePath);
    } else {
      // Get key name by removing root directory & path separator
      // (assumes `rootPath` is fully-resolved)
      yield filePath.substring(rootPath.length + 1);
    }
  }
}
function listKeysInDirectory(rootPath: string): AsyncGenerator<string> {
  rootPath = path.resolve(rootPath);
  return listKeysInDirectoryInner(rootPath, rootPath);
}

export interface SitesOptions {
  sitePath: string;
  siteInclude?: string[];
  siteExclude?: string[];
}
export interface SiteMatcherRegExps {
  include?: MatcherRegExps;
  exclude?: MatcherRegExps;
}
// Cache glob RegExps between `getBindings` and `getServices` calls
const sitesRegExpsCache = new WeakMap<SitesOptions, SiteMatcherRegExps>();

function serialiseSiteRegExps(exps: SiteMatcherRegExps) {
  return {
    include: exps.include && serialiseRegExps(exps.include),
    exclude: exps.exclude && serialiseRegExps(exps.exclude),
  };
}

function deserialiseSiteRegExps(exps: ReturnType<typeof serialiseSiteRegExps>) {
  return {
    include: exps.include && deserialiseRegExps(exps.include),
    exclude: exps.exclude && deserialiseRegExps(exps.exclude),
  };
}

function testSiteRegExps(regExps: SiteMatcherRegExps, key: string): boolean {
  return (
    // Either include globs undefined, or name matches them
    (regExps.include === undefined || testRegExps(regExps.include, key)) &&
    // Either exclude globs undefined, or name doesn't match them
    (regExps.exclude === undefined || !testRegExps(regExps.exclude, key))
  );
}

// Magic prefix: if a URLs pathname starts with this, it shouldn't be cached.
// This ensures edge caching of Workers Sites files is disabled, and the latest
// local version is always served.
const SITES_NO_CACHE_PREFIX = "$__MINIFLARE_SITES__$/";

function encodeSitesKey(key: string): string {
  // `encodeURIComponent()` ensures `ETag`s used by `@cloudflare/kv-asset-handler`
  // are always byte strings.
  return SITES_NO_CACHE_PREFIX + encodeURIComponent(key);
}
function decodeSitesKey(key: string): string {
  return key.startsWith(SITES_NO_CACHE_PREFIX)
    ? decodeURIComponent(key.substring(SITES_NO_CACHE_PREFIX.length))
    : key;
}

export function isSitesRequest(request: Request) {
  const url = new URL(request.url);
  return url.pathname.startsWith(`/${SITES_NO_CACHE_PREFIX}`);
}

const SERVICE_NAMESPACE_SITE = `${KV_PLUGIN_NAME}:site`;

const BINDING_KV_NAMESPACE_SITE = "__STATIC_CONTENT";
const BINDING_JSON_SITE_MANIFEST = "__STATIC_CONTENT_MANIFEST";
const BINDING_TEXT_SITE_FILTER = "MINIFLARE_SITE_FILTER";

const SCRIPT_SITE = `
function handleRequest(request) {
  // Only permit reads
  if (request.method !== "GET") {
    const message = \`Cannot \${request.method.toLowerCase()}() with read-only Workers Sites namespace\`;
    return new Response(message, { status: 405, statusText: message });
  }
  
  const url = new URL(request.url);
  url.pathname = \`/${KV_PLUGIN_NAME}/${BINDING_KV_NAMESPACE_SITE}/\${url.pathname}\`;
  
  request = new Request(url, request);
  request.headers.set("${HEADER_PERSIST}", ${BINDING_TEXT_PERSIST});
  // Add magic header to indicate namespace should be ignored, and persist
  // should be used as the root without any additional namespace
  request.headers.set("${HEADER_SITES}", ${BINDING_TEXT_SITE_FILTER});
  return ${CoreBindings.SERVICE_LOOPBACK}.fetch(request);
}

addEventListener("fetch", (event) => event.respondWith(handleRequest(event.request)));
`;

async function buildStaticContentManifest(
  sitePath: string,
  siteRegExps: SiteMatcherRegExps
) {
  // Build __STATIC_CONTENT_MANIFEST contents
  const staticContentManifest: Record<string, string> = {};
  for await (const key of listKeysInDirectory(sitePath)) {
    if (testSiteRegExps(siteRegExps, key)) {
      staticContentManifest[key] = encodeSitesKey(key);
    }
  }
  return staticContentManifest;
}

export async function getSitesBindings(
  options: SitesOptions
): Promise<Worker_Binding[]> {
  // Convert include/exclude globs to RegExps
  const siteRegExps: SiteMatcherRegExps = {
    include: options.siteInclude && globsToRegExps(options.siteInclude),
    exclude: options.siteExclude && globsToRegExps(options.siteExclude),
  };
  sitesRegExpsCache.set(options, siteRegExps);

  const __STATIC_CONTENT_MANIFEST = await buildStaticContentManifest(
    options.sitePath,
    siteRegExps
  );

  return [
    {
      name: BINDING_KV_NAMESPACE_SITE,
      kvNamespace: { name: SERVICE_NAMESPACE_SITE },
    },
    {
      name: BINDING_JSON_SITE_MANIFEST,
      json: JSON.stringify(__STATIC_CONTENT_MANIFEST),
    },
  ];
}
export async function getSitesNodeBindings(
  options: SitesOptions
): Promise<Record<string, unknown>> {
  const siteRegExps = sitesRegExpsCache.get(options);
  assert(siteRegExps !== undefined);
  const __STATIC_CONTENT_MANIFEST = await buildStaticContentManifest(
    options.sitePath,
    siteRegExps
  );
  return {
    [BINDING_KV_NAMESPACE_SITE]: kProxyNodeBinding,
    [BINDING_JSON_SITE_MANIFEST]: __STATIC_CONTENT_MANIFEST,
  };
}

export function maybeGetSitesManifestModule(
  bindings: Worker_Binding[]
): Worker_Module | undefined {
  for (const binding of bindings) {
    if (binding.name === BINDING_JSON_SITE_MANIFEST) {
      assert("json" in binding && binding.json !== undefined);
      return { name: BINDING_JSON_SITE_MANIFEST, text: binding.json };
    }
  }
}

export function getSitesService(options: SitesOptions): Service {
  // `siteRegExps` should've been set in `getSitesBindings()`, and `options`
  // should be the same object reference as before.
  const siteRegExps = sitesRegExpsCache.get(options);
  assert(siteRegExps !== undefined);
  // Ensure `siteRegExps` is JSON-serialisable
  const serialisedSiteRegExps = serialiseSiteRegExps(siteRegExps);

  // Use unsanitised file storage to ensure file names containing e.g. dots
  // resolve correctly.
  const persist = path.resolve(options.sitePath);

  return {
    name: SERVICE_NAMESPACE_SITE,
    worker: {
      serviceWorkerScript: SCRIPT_SITE,
      compatibilityDate: "2022-09-01",
      bindings: [
        WORKER_BINDING_SERVICE_LOOPBACK,
        {
          name: BINDING_TEXT_PERSIST,
          text: JSON.stringify(persist),
        },
        {
          name: BINDING_TEXT_SITE_FILTER,
          text: JSON.stringify(serialisedSiteRegExps),
        },
      ],
    },
  };
}

// Define Workers Sites specific KV gateway functions. We serve directly from
// disk with Workers Sites to ensure we always send the most up-to-date files.
// Otherwise, we'd have to copy files from disk to our own SQLite/blob store
// whenever any of them changed.

export async function sitesGatewayGet(
  persist: Persistence,
  serialisedSiteRegExps: string,
  key: string,
  opts?: KVGatewayGetOptions
): Promise<KVGatewayGetResult | undefined> {
  // `persist` is a resolved path set in `getSitesService()`
  assert(typeof persist === "string");
  const siteRegExps = deserialiseSiteRegExps(JSON.parse(serialisedSiteRegExps));

  validateGetOptions(key, opts);

  key = decodeSitesKey(key);
  if (!testSiteRegExps(siteRegExps, key)) return;

  const filePath = path.join(persist, key);
  if (!filePath.startsWith(persist)) return;
  try {
    return { value: await createFileReadableStream(filePath) };
  } catch (e: unknown) {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      e.code === "ENOENT"
    ) {
      return;
    }
    throw e;
  }
}

export async function sitesGatewayList(
  persist: Persistence,
  serialisedSiteRegExps: string,
  opts: KVGatewayListOptions = {}
): Promise<KVGatewayListResult> {
  // `persist` is a resolved path set in `getSitesService()`
  assert(typeof persist === "string");
  const siteRegExps = deserialiseSiteRegExps(JSON.parse(serialisedSiteRegExps));

  validateListOptions(opts);
  const { limit = MAX_LIST_KEYS, prefix, cursor } = opts;

  // Get sorted array of all keys matching prefix
  let keys: KVGatewayListResult["keys"] = [];
  for await (let name of listKeysInDirectory(persist)) {
    if (!testSiteRegExps(siteRegExps, name)) continue;
    name = encodeSitesKey(name);
    if (prefix === undefined || name.startsWith(prefix)) keys.push({ name });
  }
  keys.sort((a, b) => lexicographicCompare(a.name, b.name));

  // Apply cursor
  const startAfter = cursor === undefined ? "" : base64Decode(cursor);
  let startIndex = 0;
  if (startAfter !== "") {
    // We could do a binary search here, but listing Workers Sites namespaces
    // is an incredibly unlikely operation, so doesn't need to be optimised
    startIndex = keys.findIndex(({ name }) => name === startAfter);
    // If we couldn't find where to start, return nothing
    if (startIndex === -1) startIndex = keys.length;
    // Since we want to start AFTER this index, add 1 to it
    startIndex++;
  }

  // Apply limit
  const endIndex = startIndex + limit;
  const nextCursor =
    endIndex < keys.length ? base64Encode(keys[endIndex - 1].name) : undefined;
  keys = keys.slice(startIndex, endIndex);

  if (nextCursor === undefined) {
    return { keys, list_complete: true, cursor: undefined };
  } else {
    return { keys, list_complete: false, cursor: nextCursor };
  }
}
