const { name, version } = require(require("path").join(__dirname, "..", "package.json"));
const G: any = global || window || {};
const PACKAGE_GUARD: symbol = Symbol.for(name);
if (PACKAGE_GUARD in G) {
	const conflictVersion = G[PACKAGE_GUARD];
	// tslint:disable-next-line: max-line-length
	const msg = `Conflict module version. Look like two different version of package ${name} was loaded inside the process: ${conflictVersion} and ${version}.`;
	if (process !== undefined && process.env !== undefined && process.env.NODE_ALLOW_CONFLICT_MODULES === "1") {
		console.warn(msg + " This treats as warning because NODE_ALLOW_CONFLICT_MODULES is set.");
	} else {
		throw new Error(msg + " Use NODE_ALLOW_CONFLICT_MODULES=\"1\" to treats this error as warning.");
	}
} else {
	G[PACKAGE_GUARD] = version;
}

import * as zxteam from "@zxteam/contract";
import { Disposable, safeDispose } from "@zxteam/disposable";
import { Limit, LimitToken, limitFactory } from "@zxteam/limit";
import { loggerManager } from "@zxteam/logger";

import * as http from "http";
import * as querystring from "querystring";
import { URL } from "url";

import { WebClient, WebClientInvokeChannel, WebClientInvokeResult } from "@zxteam/webclient";

export namespace RestClient {
	export interface LimitOpts {
		instance: Limit.Opts | Limit;
		timeout: number;
	}

	export interface Opts {
		readonly limit?: LimitOpts;
		readonly webClient?: WebClient.Opts | WebClientInvokeChannel;
		readonly userAgent?: string;
		readonly log?: zxteam.Logger;
	}

	export interface Response extends WebClientInvokeResult {
		readonly bodyAsJson: any;
	}
}
export class RestClient extends Disposable {
	private static _webClientFactory?: (opts?: WebClient.Opts) => WebClientInvokeChannel;
	private readonly _baseUrl: URL;
	private readonly _webClient: WebClientInvokeChannel;
	private readonly _webClientRequiredDispose: boolean;
	private readonly _userAgent?: string;
	private readonly _limitHandle?: { instance: Limit, timeout: number, isOwnInstance: boolean };
	private _log: zxteam.Logger | null;

	public constructor(url: URL | string, opts?: RestClient.Opts) {
		super();
		this._baseUrl = typeof url === "string" ? new URL(url) : url;

		if (opts !== undefined && opts.log !== undefined) {
			this._log = opts.log;
		} else {
			this._log = loggerManager.getLogger(this.constructor.name);
		}

		if (opts !== undefined) {
			const { limit, webClient, userAgent } = opts;
			if (limit) {
				this._limitHandle = Limit.isLimitOpts(limit.instance) ?
					{
						instance: limitFactory(limit.instance), isOwnInstance: true, timeout: limit.timeout
					} : {
						instance: limit.instance, isOwnInstance: false, timeout: limit.timeout
					};
			}
			if (webClient && "invoke" in webClient) {
				this._webClient = webClient;
				this._webClientRequiredDispose = false;
			} else if (RestClient._webClientFactory) {
				this._webClient = RestClient._webClientFactory(webClient);
				this._webClientRequiredDispose = true;
			} else {
				this._webClient = new WebClient(webClient);
				this._webClientRequiredDispose = false;
			}
			if (userAgent !== undefined) {
				this._userAgent = userAgent;
			}
		}
	}

	public static setWebClientFactory(value: () => WebClientInvokeChannel) { RestClient._webClientFactory = value; }
	public static removeWebClientFactory() { delete RestClient._webClientFactory; }

	protected get log() { return this._log; }

	protected get baseUrl(): URL { return this._baseUrl; }

	protected invokeWebMethodGet(
		cancellationToken: zxteam.CancellationToken,
		webMethodName: string,
		opts?: {
			queryArgs?: { [key: string]: string },
			headers?: http.OutgoingHttpHeaders,
			limitWeight?: number
		}
	): Promise<RestClient.Response> {
		super.verifyNotDisposed();

		const { queryArgs = undefined, headers = undefined, limitWeight = undefined } = (() => opts || {})();
		const path = queryArgs !== undefined ?
			webMethodName + "?" + querystring.stringify(queryArgs) :
			webMethodName;

		return this.invoke(cancellationToken, path, "GET", { headers, limitWeight });
	}

	protected invokeWebMethodPost(
		cancellationToken: zxteam.CancellationToken,
		webMethodName: string,
		opts?: {
			postArgs?: { [key: string]: string },
			headers?: http.OutgoingHttpHeaders,
			limitWeight?: number
		}
	): Promise<RestClient.Response> {
		super.verifyNotDisposed();

		const { postArgs = undefined, headers = undefined, limitWeight = undefined } = (() => opts || {})();

		const bodyStr = postArgs && querystring.stringify(postArgs);
		const { body, bodyLength } = (() => {
			if (bodyStr !== undefined) {
				const bodyBuffer = Buffer.from(bodyStr);
				return { body: bodyBuffer, bodyLength: bodyBuffer.byteLength };
			} else {
				return { body: undefined, bodyLength: 0 };
			}
		})();

		const friendlyHeaders = (() => {
			const baseHeaders: http.OutgoingHttpHeaders = {
				"Content-Type": "application/x-www-form-urlencoded",
				"Content-Length": bodyLength
			};
			return headers !== undefined ? { ...baseHeaders, ...headers } : baseHeaders;
		})();

		return this.invoke(cancellationToken, webMethodName, "POST", { bodyBufferOrObject: body, headers: friendlyHeaders, limitWeight });
	}

	protected async invoke(
		cancellationToken: zxteam.CancellationToken,
		path: string,
		method: "GET" | "POST" | string,
		opts?: {
			headers?: http.OutgoingHttpHeaders,
			bodyBufferOrObject?: Buffer | any,
			limitWeight?: number
		}): Promise<RestClient.Response> {
		super.verifyNotDisposed();

		// tslint:disable-next-line:max-line-length
		const { bodyBufferOrObject = undefined, headers = undefined, limitWeight = 1 } = (() => opts || {})();

		let friendlyHeaders = headers !== undefined ?
			(
				// set User-Agent only if this is not present by user
				(this._userAgent !== undefined && !("User-Agent" in headers)) ?
					{ ...headers, "User-Agent": this._userAgent } :
					headers
			) :
			(
				this._userAgent !== undefined ?
					{ "User-Agent": this._userAgent } :
					undefined
			);

		const friendlyBody: Buffer | undefined =
			bodyBufferOrObject !== undefined ?
				(
					// Serialize JSON if body is object
					bodyBufferOrObject instanceof Buffer ?
						bodyBufferOrObject :
						Buffer.from(JSON.stringify(bodyBufferOrObject))
				)
				: undefined;

		let limitToken: LimitToken | null = null;
		if (this._limitHandle !== undefined) {
			if (cancellationToken !== undefined) {
				limitToken = await this._limitHandle.instance.accrueTokenLazy(limitWeight, this._limitHandle.timeout, cancellationToken);
			} else {
				limitToken = await this._limitHandle.instance.accrueTokenLazy(limitWeight, this._limitHandle.timeout);
			}
		} else {
			if (friendlyHeaders === undefined) { friendlyHeaders = {}; }
			friendlyHeaders["X-LimitJS-Weight"] = limitWeight;
		}
		try {
			const url: URL = new URL(path, this._baseUrl);

			const invokeResult: WebClientInvokeResult =
				await this._webClient.invoke(cancellationToken, { url, method, body: friendlyBody, headers: friendlyHeaders }).promise;

			const { statusCode, statusMessage, headers: responseHeaders, body } = invokeResult;

			const response: RestClient.Response = {
				get statusCode() { return statusCode; },
				get statusMessage() { return statusMessage; },
				get headers() { return responseHeaders; },
				get body() { return body; },
				get bodyAsJson() { return JSON.parse(invokeResult.body.toString()); }
			};

			if (limitToken !== null) {
				limitToken.commit();
			}

			return response;
		} catch (e) {
			if (limitToken !== null) {
				if (e instanceof WebClient.CommunicationError) {
					// Token was not spent due server side did not work any job
					limitToken.rollback();
				} else {
					limitToken.commit();
				}
			}
			throw e;
		}
	}

	protected async onDispose(): Promise<void> {
		if (this._limitHandle !== undefined) {
			if (this._limitHandle.isOwnInstance) {
				await this._limitHandle.instance.dispose().promise;
			}
		}
		if (this._webClientRequiredDispose) {
			// generally WebClientInvokeChannel is NOT disposable
			// but we do not know what implementation provider by client's web client factory
			// probably client's web client required to dispose()
			// so we trying to dispose safelly
			await safeDispose(this._webClient).promise;
		}
	}
}

export default RestClient;

