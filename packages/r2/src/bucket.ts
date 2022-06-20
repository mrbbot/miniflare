import { Blob } from "buffer";
import { arrayBuffer } from "stream/consumers";
import { ReadableStream } from "stream/web";
import { TextEncoder } from "util";
import {
  RequestContext,
  Storage,
  StoredValueMeta,
  assertInRequest,
  getRequestContext,
  viewToArray,
  waitForOpenInputGate,
  waitForOpenOutputGate,
} from "@miniflare/shared";
import { Headers } from "undici";
import {
  R2Object,
  R2ObjectBody,
  createMD5,
  createVersion,
  parseHttpMetadata,
  parseOnlyIf,
  testR2Conditional,
} from "./r2Object";
import { R2HTTPMetadata, R2ObjectMetadata } from "./r2Object";

// For more information, refer to https://datatracker.ietf.org/doc/html/rfc7232
export interface R2Conditional {
  // Performs the operation if the object’s etag matches the given string.
  etagMatches?: string | string[];
  // Performs the operation if the object’s etag does not match the given string.
  etagDoesNotMatch?: string | string[];
  // Performs the operation if the object was uploaded before the given date.
  uploadedBefore?: Date;
  // Performs the operation if the object was uploaded after the given date.
  uploadedAfter?: Date;
}

export type R2Range = { offset?: number; length?: number; suffix?: number };

export type R2GetOptions = {
  // Specifies that the object should only be returned given satisfaction of
  // certain conditions in the R2Conditional. Refer to R2Conditional above.
  onlyIf?: R2Conditional | Headers;
  // Specifies that only a specific length (from an optional offset) or suffix
  // of bytes from the object should be returned. Refer to
  // https://developers.cloudflare.com/r2/runtime-apis/#ranged-reads.
  range?: R2Range;
};

export type R2PutValueType =
  | ReadableStream
  | ArrayBuffer
  | ArrayBufferView
  | string
  | null
  | Blob;
export interface R2PutOptions {
  // Specifies that the object should only be stored given satisfaction of
  // certain conditions in the R2Conditional. Refer to R2Conditional above.
  onlyIf?: R2Conditional | Headers;
  // Various HTTP headers associated with the object. Refer to
  // https://developers.cloudflare.com/r2/runtime-apis/#http-metadata.
  httpMetadata?: R2HTTPMetadata | Headers;
  // A map of custom, user-defined metadata that will be stored with the object.
  customMetadata?: Record<string, string>;
  // A md5 hash to use to check the recieved object’s integrity.
  md5?: ArrayBuffer | string;
}

type R2ListOptionsInclude = ("httpMetadata" | "customMetadata")[];

export interface R2ListOptions {
  // The number of results to return. Defaults to 1000, with a maximum of 1000.
  limit?: number;
  // The prefix to match keys against. Keys will only be returned if they start with given prefix.
  prefix?: string;
  // An opaque token that indicates where to continue listing objects from.
  // A cursor can be retrieved from a previous list operation.
  cursor?: string;
  // The character to use when grouping keys.
  delimiter?: string;
  // Can include httpMetadata and/or customMetadata. If included, items returned by
  // the list will include the specified metadata. Note that there is a limit on the
  // total amount of data that a single list operation can return.
  // If you request data, you may recieve fewer than limit results in your response
  // to accomodate metadata.
  // Use the truncated property to determine if the list request has more data to be returned.
  include?: R2ListOptionsInclude;
}

export interface R2Objects {
  // An array of objects matching the list request.
  objects: R2Object[];
  // If true, indicates there are more results to be retrieved for the current list request.
  truncated: boolean;
  // A token that can be passed to future list calls to resume listing from that point.
  // Only present if truncated is true.
  cursor?: string;
  // If a delimiter has been specified, contains all prefixes between the specified
  // prefix and the next occurence of the delimiter.
  // For example, if no prefix is provided and the delimiter is ‘/’, foo/bar/baz
  // would return foo as a delimited prefix. If foo/ was passed as a prefix
  // with the same structure and delimiter, foo/bar would be returned as a delimited prefix.
  delimitedPrefixes: string[];
}

const MAX_LIST_KEYS = 1_000;
const MAX_KEY_SIZE = 512; /* 512B */
// https://developers.cloudflare.com/r2/platform/limits/ (5GB - 5MB)
const MAX_VALUE_SIZE = 5 * 1_000 * 1_000 * 1_000 - 5 * 1_000 * 1_000;

const encoder = new TextEncoder();

type Method = "HEAD" | "GET" | "PUT" | "LIST" | "DELETE";

function throwR2Error(method: Method, status: number, message: string): void {
  throw new Error(`R2 ${method} failed: ${status} ${message}`);
}

function validateKey(method: Method, key: string): void {
  // Check key name is allowed
  if (key === "") throw new TypeError("Key name cannot be empty.");
  if (key === ".") throw new TypeError('"." is not allowed as a key name.');
  if (key === "..") throw new TypeError('".." is not allowed as a key name.');
  // Check key isn't too long
  const keyLength = encoder.encode(key).byteLength;
  if (keyLength > MAX_KEY_SIZE) {
    throwR2Error(
      method,
      414,
      `UTF-8 encoded length of ${keyLength} exceeds key length limit of ${MAX_KEY_SIZE}.`
    );
  }
}

function validateOnlyIf(onlyIf: R2Conditional | Headers): void {
  if (!(onlyIf instanceof Headers) && typeof onlyIf !== "object") {
    throwR2Error(
      "GET",
      400,
      "onlyIf must be an object, a Headers instance, or undefined."
    );
  }

  if (!(onlyIf instanceof Headers)) {
    // Check onlyIf variables
    const { etagMatches, etagDoesNotMatch, uploadedBefore, uploadedAfter } =
      onlyIf;

    if (
      etagMatches &&
      !(typeof etagMatches === "string" || Array.isArray(etagMatches))
    ) {
      throwR2Error("GET", 400, "etagMatches must be a string.");
    }
    if (
      etagDoesNotMatch &&
      !(typeof etagDoesNotMatch === "string" || Array.isArray(etagDoesNotMatch))
    ) {
      throwR2Error("GET", 400, "etagDoesNotMatch must be a string.");
    }
    if (uploadedBefore && !(uploadedBefore instanceof Date)) {
      throwR2Error("GET", 400, "uploadedBefore must be a Date.");
    }
    if (uploadedAfter && !(uploadedAfter instanceof Date)) {
      throwR2Error("GET", 400, "uploadedAfter must be a Date.");
    }
  }
}

function validateR2GetOptions(options: R2GetOptions): void {
  const { onlyIf = {}, range = {} } = options;

  validateOnlyIf(onlyIf);

  if (typeof range !== "object") {
    throwR2Error("GET", 400, "range must be an object or undefined.");
  }
  const { offset, length, suffix } = range;

  if (offset !== undefined && !isNaN(offset)) {
    throwR2Error("GET", 400, "offset must be a number.");
  }
  if (length !== undefined && !isNaN(length)) {
    throwR2Error("GET", 400, "length must be a number.");
  }
  if (suffix !== undefined && !isNaN(suffix)) {
    throwR2Error("GET", 400, "suffix must be a number.");
  }
}

function validateHttpMetadata(httpMetadata?: R2HTTPMetadata | Headers): void {
  if (httpMetadata === undefined || httpMetadata instanceof Headers) return;
  for (const [key, value] of Object.entries(httpMetadata)) {
    if (key === "cacheExpiry") {
      if (!(value instanceof Date) && value !== undefined) {
        throwR2Error(
          "PUT",
          400,
          "cacheExpiry's value must be a Date or undefined."
        );
      }
    } else {
      if (typeof value !== "string" && value !== undefined) {
        throwR2Error(
          "PUT",
          400,
          `${key}'s value must be a string or undefined.`
        );
      }
    }
  }
}

function validateR2PutOptions(options: R2PutOptions): void {
  const { onlyIf = {}, httpMetadata, customMetadata, md5 } = options;

  validateOnlyIf(onlyIf);
  validateHttpMetadata(httpMetadata);

  if (customMetadata !== undefined) {
    if (typeof customMetadata !== "object") {
      throwR2Error(
        "PUT",
        400,
        "customMetadata must be an object or undefined."
      );
    }
    for (const value of Object.values(customMetadata)) {
      if (typeof value !== "string") {
        throwR2Error("PUT", 400, "customMetadata values must be strings.");
      }
    }
  }

  if (
    md5 !== undefined &&
    !(md5 instanceof ArrayBuffer) &&
    typeof md5 !== "string"
  ) {
    throwR2Error(
      "PUT",
      400,
      "md5 must be a string, ArrayBuffer, or undefined."
    );
  }
}

export interface InternalR2BucketOptions {
  blockGlobalAsyncIO?: boolean;
}

export class R2Bucket {
  readonly #storage: Storage;
  readonly #blockGlobalAsyncIO: boolean;

  constructor(
    storage: Storage,
    { blockGlobalAsyncIO = false }: InternalR2BucketOptions = {}
  ) {
    this.#storage = storage;
    this.#blockGlobalAsyncIO = blockGlobalAsyncIO;
  }

  #prepareCtx(method: Method, key?: string): RequestContext | undefined {
    if (this.#blockGlobalAsyncIO) assertInRequest();
    const ctx = getRequestContext();
    ctx?.incrementInternalSubrequests();
    // noinspection SuspiciousTypeOfGuard
    if (key !== undefined && typeof key !== "string") {
      throw new TypeError(
        `Failed to execute '${method.toLowerCase()}'` +
          " on 'R2Bucket': parameter 1 is not of type 'string'."
      );
    }

    return ctx;
  }

  async head(key: string): Promise<R2Object | null> {
    const ctx = this.#prepareCtx("HEAD", key);

    // Validate key
    validateKey("HEAD", key);

    // Get value, returning null if not found
    const stored = await this.#storage.meta?.<R2ObjectMetadata>(key);
    await waitForOpenInputGate();
    ctx?.advanceCurrentTime();
    if (stored?.metadata === undefined) return null;
    const { metadata } = stored;

    return new R2Object(metadata);
  }

  /**
   * Returns R2Object on a failure of the conditional specified in onlyIf.
   */
  async get(key: string): Promise<R2ObjectBody | null>;
  async get(
    key: string,
    options: R2GetOptions
  ): Promise<R2ObjectBody | R2Object | null>;
  async get(
    key: string,
    options?: R2GetOptions
  ): Promise<R2ObjectBody | R2Object | null> {
    const ctx = this.#prepareCtx("GET", key);
    options = options ?? {};
    const { range = {} } = options;

    // Validate key
    validateKey("GET", key);
    // Validate options
    validateR2GetOptions(options);

    // In the event that an onlyIf precondition fails, we return
    // the R2Object without the body. Otherwise return with body.
    const onlyIf = parseOnlyIf(options.onlyIf);
    const meta = await this.#storage.meta?.<R2ObjectMetadata>(key);
    if (
      (meta?.metadata && testR2Conditional(onlyIf, meta.metadata)) ||
      meta?.metadata?.size === 0
    ) {
      return new R2Object(meta.metadata);
    }
    // if bad metadata, return null
    if (meta?.metadata === undefined) return null;

    let stored: StoredValueMeta<R2ObjectMetadata> | undefined;

    // get data dependent upon whether suffix or range exists
    if (typeof range.suffix === "number") {
      try {
        stored = await this.#storage.getSuffixMaybeExpired?.<R2ObjectMetadata>(
          key,
          range.suffix
        );
      } catch (_) {
        throwR2Error("GET", 400, "The requested range is not satisfiable.");
      }
    } else if (
      typeof range.offset === "number" ||
      typeof range.length === "number"
    ) {
      if (typeof range.length === "number" && range.length === 0) {
        throwR2Error("GET", 400, "The requested range is not satisfiable.");
      }
      try {
        stored = await this.#storage.getRangeMaybeExpired?.<R2ObjectMetadata>(
          key,
          range.offset ?? 0,
          range.length
        );
      } catch (_) {
        throwR2Error("GET", 400, "The requested range is not satisfiable.");
      }
    } else {
      stored = await this.#storage.get<R2ObjectMetadata>(key);
    }

    await waitForOpenInputGate();
    ctx?.advanceCurrentTime();
    // if bad metadata, return null
    if (stored?.metadata === undefined) return null;
    const { value, metadata } = stored;

    return new R2ObjectBody(metadata, value);
  }

  async put(
    key: string,
    value: R2PutValueType,
    options: R2PutOptions = {}
  ): Promise<R2Object | null> {
    const ctx = this.#prepareCtx("PUT", key);
    // Validate key
    validateKey("PUT", key);
    // Validate options
    validateR2PutOptions(options);
    // validate md5
    let { md5 } = options;
    if (md5 !== undefined) {
      if (typeof md5 !== "string" && !(md5 instanceof ArrayBuffer)) {
        throwR2Error("PUT", 400, "The Content-MD5 you specified is not valid.");
      }
    }

    const { customMetadata = {} } = options;
    let { onlyIf, httpMetadata } = options;
    onlyIf = parseOnlyIf(onlyIf);
    httpMetadata = parseHttpMetadata(httpMetadata);

    // Get meta, and if exists, run onlyIf condtional test
    const meta = await this.#storage.meta?.<R2ObjectMetadata>(key);
    if (meta?.metadata && testR2Conditional(onlyIf, meta.metadata)) {
      return null;
    }

    // Convert value to Uint8Array
    let stored: Uint8Array;
    if (typeof value === "string") {
      stored = encoder.encode(value);
    } else if (value instanceof ReadableStream) {
      // @ts-expect-error @types/node stream/consumers doesn't accept ReadableStream
      stored = new Uint8Array(await arrayBuffer(value));
    } else if (value instanceof ArrayBuffer) {
      stored = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
      stored = viewToArray(value);
    } else if (value === null) {
      stored = new Uint8Array();
    } else if (value instanceof Blob) {
      stored = new Uint8Array(await value.arrayBuffer());
    } else {
      throw new TypeError(
        "R2 put() accepts only nulls, strings, Blobs, ArrayBuffers, ArrayBufferViews, and ReadableStreams as values."
      );
    }

    // Validate value and metadata size
    if (stored.byteLength > MAX_VALUE_SIZE) {
      throwR2Error(
        "PUT",
        400,
        `Value length of ${stored.byteLength} exceeds limit of ${MAX_VALUE_SIZE}.`
      );
    }

    // if md5 is provided, check objects integrity
    const md5Hash = createMD5(stored);
    if (md5 !== undefined) {
      // convert to string
      if (md5 instanceof ArrayBuffer) {
        md5 = Buffer.from(new Uint8Array(md5)).toString("hex");
      }
      if (md5 !== md5Hash) {
        throwR2Error(
          "PUT",
          400,
          "The Content-MD5 you specified did not match what we received."
        );
      }
    }

    // build metadata
    const metadata: R2ObjectMetadata = {
      key,
      size: stored.byteLength,
      etag: md5Hash,
      version: createVersion(),
      httpEtag: `"${md5Hash}"`,
      uploaded: new Date(),
      httpMetadata,
      customMetadata,
    };

    // Store value with expiration and metadata
    await waitForOpenOutputGate();
    await this.#storage.put<R2ObjectMetadata>(key, {
      value: stored,
      metadata,
    });
    await waitForOpenInputGate();
    ctx?.advanceCurrentTime();

    return new R2Object(metadata);
  }

  async delete(key: string): Promise<void> {
    const ctx = this.#prepareCtx("DELETE", key);

    validateKey("DELETE", key);
    await waitForOpenOutputGate();
    await this.#storage.delete(key);
    await waitForOpenInputGate();
    ctx?.advanceCurrentTime();
  }

  // due to the delimiter, we may need to run multiple queries
  async #list(
    prefix: string,
    limit: number,
    include: R2ListOptionsInclude,
    delimitedPrefixes: Set<string>,
    delimiter?: string,
    cursor?: string
  ): Promise<{ objects: R2Object[]; cursor?: string }> {
    const res = await this.#storage.list<R2ObjectMetadata>({
      prefix,
      limit,
      cursor,
    });

    const objects = res.keys
      // grab metadata
      .map((k) => k.metadata)
      // filter out undefined metadata
      .filter(
        (metadata): metadata is R2ObjectMetadata => metadata !== undefined
      )
      // filter out objects that exist within the delimiter
      .filter((metadata) => {
        if (delimiter === undefined) return true;
        const objectKey = metadata.key.slice(prefix.length);
        if (objectKey.includes(delimiter)) {
          const delimitedPrefix =
            prefix + objectKey.split(delimiter)[0] + delimiter;
          delimitedPrefixes.add(delimitedPrefix);
          return false;
        }
      })
      // filter "httpMetadata" and/or "customMetadata", return R2Object
      .map((metadata) => {
        if (!include.includes("httpMetadata")) metadata.httpMetadata = {};
        if (!include.includes("customMetadata")) metadata.customMetadata = {};

        return new R2Object(metadata);
      });

    return { objects, cursor: res.cursor };
  }

  async list({
    prefix = "",
    limit = MAX_LIST_KEYS,
    cursor,
    include = [],
    delimiter,
  }: R2ListOptions = {}): Promise<R2Objects> {
    const ctx = this.#prepareCtx("LIST");
    let truncated = false;
    const objects: R2Object[] = [];
    const delimitedPrefixes = new Set<string>();

    // Validate options
    if (typeof limit !== "number" || limit < 1 || limit > MAX_LIST_KEYS) {
      throwR2Error(
        "LIST",
        400,
        `MaxKeys params must be positive integer <= 1000.`
      );
    }
    // if include contains inputs, we reduce the limit to max 100
    if (include.length > 0) limit = Math.min(limit, 100);

    while (objects.length + delimitedPrefixes.size < limit) {
      const { objects: newObjects, cursor: newCursor } = await this.#list(
        prefix,
        limit - objects.length, // adjust limit to have the correct cursor returned
        include,
        delimitedPrefixes,
        delimiter,
        cursor
      );
      cursor = newCursor;
      if (newObjects.length === 0) break;
      objects.push(...newObjects);
    }

    if (cursor !== undefined) truncated = true;
    await waitForOpenInputGate();
    ctx?.advanceCurrentTime();

    return {
      objects,
      truncated,
      cursor,
      delimitedPrefixes: [...delimitedPrefixes],
    };
  }
}
