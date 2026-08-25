/**
 * A scripted stand-in for the host's services. Every call is recorded so a test can read
 * what a node asked for, and no live key or network call is involved anywhere.
 */
import type { AssetRef, ImageParams, ImageResult } from '@vn/types';
import { sha256 } from '@vn/util';

import type {
  GenBlobRef,
  GenFetchInit,
  GenFetchResult,
  GenImageInput,
  GenServices,
} from '../../../index.js';

export interface MockImageCall {
  kind: 'generate' | 'edit';
  prompt: string;
  base?: GenImageInput;
  refs: GenImageInput[];
  params: ImageParams;
}

export interface MockTextCall {
  modelId: string;
  prompt: string;
  system?: string;
}

export interface MockFetchCall {
  url: string;
  init: GenFetchInit;
}

/** What a scripted request answers with. An absent status counts as 200. */
export interface MockFetchReply {
  status?: number;
  body?: string | Uint8Array;
}

export interface MockServices extends GenServices {
  images: MockImageCall[];
  texts: MockTextCall[];
  fetches: MockFetchCall[];
  blobs: GenServices['blobs'] & { stored: Map<string, Uint8Array> };
  /** Bytes keyed by `<hash>.<ext>`, the way the asset store addresses them. */
  assetBytes: Map<string, Uint8Array>;
  slotAssets: Map<string, AssetRef>;
  /** What the text service answers with. */
  reply: string;
  /** What both image calls answer with. */
  drawn: ImageResult;
}

export interface MockOptions {
  reply?: string;
  drawn?: Partial<ImageResult>;
  /** Answers a node's own request. A test leaving it out has every request refused. */
  answer?: (call: MockFetchCall) => MockFetchReply;
  /** The keys a node may ask for, keyed by the name it asks under. */
  keys?: Record<string, string>;
}

export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Records an asset under the hash of its own bytes, the way the real store addresses one. */
export function putAsset(mock: MockServices, text: string, ext = 'png'): AssetRef {
  const ref: AssetRef = { hash: sha256(bytes(text)), ext };
  mock.assetBytes.set(`${ref.hash}.${ref.ext}`, bytes(text));
  return ref;
}

export function mockServices(options: MockOptions = {}): MockServices {
  const stored = new Map<string, Uint8Array>();
  const assetBytes = new Map<string, Uint8Array>();
  const slotAssets = new Map<string, AssetRef>();

  const mock: MockServices = {
    images: [],
    texts: [],
    fetches: [],
    assetBytes,
    slotAssets,
    reply: options.reply ?? 'a rewritten line',
    drawn: {
      bytes: bytes('drawn picture'),
      ext: 'png',
      modelId: 'mock-image',
      ...options.drawn,
    },

    image: {
      generate: (prompt: string, refs: GenImageInput[], params: ImageParams) => {
        mock.images.push({ kind: 'generate', prompt, refs, params });
        return Promise.resolve(mock.drawn);
      },
      edit: (base: GenImageInput, prompt: string, refs: GenImageInput[], params: ImageParams) => {
        mock.images.push({ kind: 'edit', prompt, base, refs, params });
        return Promise.resolve(mock.drawn);
      },
    },

    text: {
      complete: (modelId: string, prompt: string, system?: string) => {
        mock.texts.push({ modelId, prompt, system });
        return Promise.resolve(mock.reply);
      },
      structured: <T>(
        modelId: string,
        prompt: string,
        parse: (raw: string) => T,
        system?: string,
      ) => {
        mock.texts.push({ modelId, prompt, system });
        return Promise.resolve(parse(mock.reply));
      },
    },

    blobs: {
      stored,
      read: (hash: string) => Promise.resolve(stored.get(hash)),
      write: (data: Uint8Array, ext: string): Promise<GenBlobRef> => {
        const hash = sha256(data);
        stored.set(hash, data);
        return Promise.resolve({ hash, ext });
      },
    },

    assets: {
      read: (ref: AssetRef) => Promise.resolve(assetBytes.get(`${ref.hash}.${ref.ext}`)),
      slot: (slotKey: string) => Promise.resolve(slotAssets.get(slotKey)),
    },

    fetch: (url: string, init: GenFetchInit = {}): Promise<GenFetchResult> => {
      const call: MockFetchCall = { url, init };
      mock.fetches.push(call);

      if (options.answer === undefined) {
        return Promise.reject(new Error('this test scripted no answer for a request'));
      }
      const reply = options.answer(call);
      const body = reply.body ?? '';
      return Promise.resolve({
        status: reply.status ?? 200,
        headers: {},
        bytes: typeof body === 'string' ? bytes(body) : body,
      });
    },
    key: (name: string) => Promise.resolve(options.keys?.[name]),
  };

  return mock;
}
