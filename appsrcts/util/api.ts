
import * as ExtendableError from "es6-error";
import * as querystring from "querystring";

import * as needle from "../promised/needle";
import urls from "../constants/urls";

import mkcooldown from "./cooldown";
import mklog from "./log";
import {camelifyObject} from "./format";

import {contains} from "underscore";

import {IDownloadKey} from "../types/db";

const cooldown = mkcooldown(130);
const log = mklog("api");
const logger = new mklog.Logger({sinks: {console: !!process.env.LET_ME_IN}});
const opts = {logger};

// cf. https://github.com/itchio/itchio-app/issues/48
// basically, lua returns empty-object instead of empty-array
// because they're the same in lua (empty table). not in JSON though.
export function ensureArray (v: any): Array<any> {
  if (!v || !v.length) {
    return [];
  }
  return v;
}

export class ApiError extends ExtendableError {
  errors: Array<string>;
  stack: string;
  message: string;
  
  constructor (errors: Array<string>) {
    super(errors.join(", "));
    this.errors = errors;
    this.stack = new Error().stack;
    this.message = errors.join(", ");
  }

  toString () {
    return `API Error: ${this.errors.join(", ")}`;
  }
}

import * as http from "http";
import * as https from "https";

let agent: http.Agent;

type HTTPMethod = "get" | "head" | "post";

interface ITransformerMap {
  [key: string]: (input: any) => any;
}

/**
 * async Wrapper for the itch.io API
 */
export class Client {
  /** base URL for API requests */
  rootUrl: string;

  /** timestamp of last request */
  lastRequest: number;

  constructor () {
    this.rootUrl = `${urls.itchioApi}/api/1`;
    this.lastRequest = 0;
  }

  async request (method: HTTPMethod, path: string, data: any = {}, transformers: ITransformerMap = {}): Promise<any> {
    if (!agent) {
      const hasHttpProxy = needle.proxy && !/https:/i.test(needle.proxy);
      const hasHttpApi = !/https:/i.test(urls.itchioApi);
      if (hasHttpProxy || hasHttpApi) {
        agent = new http.Agent({
          keepAlive: true,
          maxSockets: 1,
        });
      } else {
        agent = new https.Agent({
          keepAlive: true,
          maxSockets: 1,
        });
      }
    }

    const t1 = Date.now();

    const uri = `${this.rootUrl}${path}`;

    await cooldown();
    const t2 = Date.now();

    const resp = await needle.requestAsync(method, uri, data, {
      agent,
    });
    const body = resp.body;
    const t3 = Date.now();

    const shortPath = path.replace(/^\/[^\/]*\//, "");
    log(opts, `${t2 - t1}ms wait, ${t3 - t2}ms http, ${method} ${shortPath} with ${JSON.stringify(data)}`);

    if (resp.statusCode !== 200) {
      throw new Error(`HTTP ${resp.statusCode} ${path}`);
    }

    if (body.errors) {
      throw new ApiError(body.errors);
    }
    const camelBody = camelifyObject(body);
    for (const key in transformers) {
      if (!transformers.hasOwnProperty(key)) {
        continue;
      }
      camelBody[key] = transformers[key](camelBody[key]);
    }

    return camelBody;
  }

  async loginKey (key: string): Promise<any> {
    return await this.request("post", `/${key}/me`, {
      source: "desktop",
    });
  }

  async loginWithPassword (username: string, password: string): Promise<any> {
    return await this.request("post", "/login", {
      username: username,
      password: password,
      source: "desktop",
    });
  }

  withKey (key: string): AuthenticatedClient {
    return new AuthenticatedClient(this, key);
  }

  hasAPIError (errorObject: ApiError, apiError: string): boolean {
    return contains(errorObject.errors || [], apiError);
  }

  isNetworkError (errorObject: any): boolean {
    return (typeof errorObject === "object" && errorObject.code) && (
      // DNS lookup failed (*nix)
      errorObject.code === "ENOTFOUND" ||
      // lost connectivity in the middle of request
      errorObject.code === "ECONNRESET" ||
      // DNS lookup failed (windows)
      (errorObject.code === "ENOENT" && /getaddrinfo/.test(errorObject.message))
    );
  }
}

export const client = new Client();
export default client;

/**
 * A user, according to the itch.io API
 */
export class AuthenticatedClient {
  client: Client;
  key: string;

  constructor (pClient: Client, key: string) {
    this.client = pClient;
    this.key = key;
  }

  itchfsURL (path: string, data: any = {}) {
    const queryParams = Object.assign({}, {
      api_key: this.key,
    }, data);
    return `itchfs://${path}?${querystring.stringify(queryParams)}`;
  }

  async request (method: HTTPMethod, path: string, data: any = {}, transformers: ITransformerMap = {}): Promise<any> {
    const url = `/${this.key}${path}`;
    return await this.client.request(method, url, data, transformers);
  }

  // TODO: paging, for the prolific game dev.
  async myGames (data: any = {}): Promise<any> {
    return await this.request("get", "/my-games", data, {games: ensureArray});
  }

  async myOwnedKeys (data = {}): Promise<any> {
    return await this.request("get", "/my-owned-keys", data, {ownedKeys: ensureArray});
  }

  async me (): Promise<any> {
    return await this.request("get", "/me");
  }

  async myCollections (): Promise<any> {
    return await this.request("get", "/my-collections", {}, {collections: ensureArray});
  }

  async game (gameID: number): Promise<any> {
    return await this.request("get", `/game/${gameID}`);
  }

  async user (userID: number): Promise<any> {
    return await this.request("get", `/users/${userID}`);
  }

  async collection (collectionID: number): Promise<any> {
    return await this.request("get", `/collection/${collectionID}`);
  }

  async collectionGames (collectionID: number, page = 1): Promise<any> {
    return await this.request("get", `/collection/${collectionID}/games`, {page});
  }

  async searchGames (query: string): Promise<any> {
    return await this.request("get", "/search/games", {query}, {games: ensureArray});
  }

  async searchUsers (query: string): Promise<any> {
    return await this.request("get", "/search/users", {query}, {users: ensureArray});
  }

  // list uploads

  async listUploads (downloadKey: IDownloadKey, gameID: number): Promise<any> {
    if (downloadKey) {
      return await this.request("get", `/download-key/${downloadKey.id}/uploads`, {}, {uploads: ensureArray});
    } else {
      return await this.request("get", `/game/${gameID}/uploads`, {}, {uploads: ensureArray});
    }
  }

  // download uploads

  async downloadUpload (downloadKey: IDownloadKey, uploadID: number): Promise<any> {
    if (downloadKey) {
      return await this.request("get", `/download-key/${downloadKey.id}/download/${uploadID}`);
    } else {
      return await this.request("get", `/upload/${uploadID}/download`);
    }
  }

  downloadUploadURL (downloadKey: IDownloadKey, uploadID: number): string {
    if (downloadKey) {
      return this.itchfsURL(`/download-key/${downloadKey.id}/download/${uploadID}`);
    } else {
      return this.itchfsURL(`/upload/${uploadID}/download`);
    }
  }

  // wharf-related endpoints (bit of a mess tbh)

  async findUpgrade (downloadKey: IDownloadKey, uploadID: number, currentBuildID: number): Promise<any> {
    if (downloadKey) {
      return await this.request("get", `/download-key/${downloadKey.id}/upgrade/${uploadID}/${currentBuildID}`, {v: 2});
    } else {
      return await this.request("get", `/upload/${uploadID}/upgrade/${currentBuildID}`, {v: 2});
    }
  }

  async downloadBuild (downloadKey: IDownloadKey, uploadID: number, buildID: number): Promise<any> {
    if (downloadKey) {
      return await this.request("get", `/download-key/${downloadKey.id}/download/${uploadID}/builds/${buildID}`);
    } else {
      return await this.request("get", `/upload/${uploadID}/download/builds/${buildID}`);
    }
  }

  downloadBuildURL (downloadKey: IDownloadKey, uploadID: number, buildID: number, extra?: string): string {
    let path = "";

    if (downloadKey) {
      path = `/download-key/${downloadKey.id}/download/${uploadID}/builds/${buildID}`;
    } else {
      path = `/upload/${uploadID}/download/builds/${buildID}`;
    }

    if (extra) {
      path = `${path}/${extra}`;
    }

    return this.itchfsURL(path);
  }

  async subkey (gameID: number, scope: string) {
    return await this.request("post", "/credentials/subkey", {game_id: gameID, scope});
  }
}
