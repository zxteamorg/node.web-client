import * as http from "http";
import * as querystring from "querystring";
import { URL } from "url";
import { Limit, LimitToken, limitFactory } from "limit.js";
import { LoggerLike, CancellationTokenLike } from "@zxteam/contract";
import { Disposable } from "@zxteam/disposable";
import { loggerFactory } from "@zxteam/logger";

import { WebClient, WebClientLike, WebClientInvokeResult } from "@zxteam/webclient";

export namespace RestClient {
	export interface LimitOpts {
		instance: Limit.Opts | Limit;
		timeout: number;
	}

	export interface Opts {
		readonly limit?: LimitOpts;
		readonly webClient?: WebClient.Opts | WebClientLike;
		readonly userAgent?: string;
	}

	export interface Response extends WebClientInvokeResult {
		readonly bodyAsJson: any;
	}
}
export class RestClient extends Disposable {
	private static _webClientFactory?: (opts?: WebClient.Opts) => WebClientLike;
	private readonly _baseUrl: URL;
	private readonly _webClient: WebClientLike;
	private readonly _userAgent?: string;
	private readonly _limitHandle?: { instance: Limit, timeout: number, isOwnInstance: boolean };
	private _log: LoggerLike | null;

	public constructor(url: URL | string, opts?: RestClient.Opts) {
		super();
		this._baseUrl = typeof url === "string" ? new URL(url) : url;
		this._log = null;
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
			} else if (RestClient._webClientFactory) {
				this._webClient = RestClient._webClientFactory(webClient);
			} else {
				this._webClient = new WebClient(webClient);
			}
			if (userAgent !== undefined) {
				this._userAgent = userAgent;
			}
		}
	}

	public static setWebClientFactory(value: () => WebClientLike) { RestClient._webClientFactory = value; }
	public static removeWebClientFactory() { delete RestClient._webClientFactory; }

	public get log() {
		if (this._log !== null) {
			return this._log;
		}
		this._log = loggerFactory.getLogger(this.constructor.name);
		if (this._webClient instanceof WebClient) {
			this._webClient.log = this._log;
		}
		return this._log;
	}
	public set log(value: LoggerLike) {
		if (this._webClient instanceof WebClient) {
			this._webClient.log = value;
		}
		this._log = value;
	}

	protected get baseUrl(): URL { return this._baseUrl; }

	protected invokeWebMethodGet(
		webMethodName: string,
		opts?: {
			queryArgs?: { [key: string]: string },
			headers?: http.OutgoingHttpHeaders,
			cancellationToken?: CancellationTokenLike,
			limitWeight?: number
		}
	): Promise<RestClient.Response> {
		super.verifyNotDisposed();

		const { queryArgs = undefined, headers = undefined, cancellationToken = undefined, limitWeight = undefined } = (() => opts || {})();
		const path = queryArgs !== undefined ?
			webMethodName + "?" + querystring.stringify(queryArgs) :
			webMethodName;

		return this.invoke(path, "GET", { headers, cancellationToken, limitWeight });
	}

	protected invokeWebMethodPost(
		webMethodName: string,
		opts?: {
			postArgs?: { [key: string]: string },
			headers?: http.OutgoingHttpHeaders,
			cancellationToken?: CancellationTokenLike,
			limitWeight?: number
		}
	): Promise<RestClient.Response> {
		super.verifyNotDisposed();

		const { postArgs = undefined, headers = undefined, cancellationToken = undefined, limitWeight = undefined } = (() => opts || {})();

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

		return this.invoke(webMethodName, "POST", { bodyBufferOrObject: body, headers: friendlyHeaders, cancellationToken, limitWeight });
	}

	protected async invoke(
		path: string,
		method: "GET" | "POST" | string,
		opts?: {
			headers?: http.OutgoingHttpHeaders,
			bodyBufferOrObject?: Buffer | any,
			cancellationToken?: CancellationTokenLike,
			limitWeight?: number
		}): Promise<RestClient.Response> {
		super.verifyNotDisposed();

		// tslint:disable-next-line:max-line-length
		const { bodyBufferOrObject = undefined, headers = undefined, cancellationToken = undefined, limitWeight = 1 } = (() => opts || {})();

		const friendlyHeaders = headers !== undefined ?
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
				limitToken = await this._limitHandle.instance.accrueTokenLazy(limitWeight, this._limitHandle.timeout || 500, cancellationToken);
			} else {
				limitToken = await this._limitHandle.instance.accrueTokenLazy(limitWeight, this._limitHandle.timeout || 500);
			}
		}
		try {
			const url: URL = new URL(path, this._baseUrl);

			const invokeResult: WebClientInvokeResult =
				await this._webClient.invoke({ url, method, body: friendlyBody, headers: friendlyHeaders }, cancellationToken);

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
				await this._limitHandle.instance.dispose();
			}
		}
	}
}

export default RestClient;

