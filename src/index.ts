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
		limit?: LimitOpts;
		webClient?: WebClient.Opts | WebClientLike;
		userAgent?: string;
	}
}
export class RestClient extends Disposable {
	private static _webClientFactory?: (opts?: WebClient.Opts) => WebClientLike;
	private readonly _baseUrl: URL;
	private readonly _webClient: WebClientLike;
	private readonly _userAgent?: string;
	private readonly _limitHandle?: { instance: Limit, timeout: number, isOwnInstance: boolean };
	private _log: LoggerLike | null;

	public constructor(url: URL | string, opts: RestClient.Opts) {
		super();
		const { limit, webClient, userAgent } = opts;
		this._baseUrl = typeof url === "string" ? new URL(url) : url;
		if (limit) {

			this._limitHandle = Limit.isLimitOpts(limit.instance) ?
				{
					instance: limitFactory(limit.instance), isOwnInstance: true, timeout: limit.timeout
				} : {
					instance: limit.instance, isOwnInstance: false, timeout: limit.timeout
				};
		}
		this._log = null;
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
			cancellationToken?: CancellationTokenLike
		}
	): Promise<any> {
		super.verifyNotDisposed();

		const { queryArgs, headers, cancellationToken } = (
			() => opts || { queryArgs: undefined, headers: undefined, cancellationToken: undefined }
		)();
		const path = queryArgs !== undefined ?
			webMethodName + "?" + querystring.stringify(queryArgs) :
			webMethodName;

		return this.invoke(path, "GET", { headers, cancellationToken });
	}

	protected invokeWebMethodPost(
		webMethodName: string,
		opts?: {
			postArgs?: { [key: string]: string },
			headers?: http.OutgoingHttpHeaders,
			cancellationToken?: CancellationTokenLike
		}
	): Promise<any> {
		super.verifyNotDisposed();

		const { postArgs, headers, cancellationToken } = (
			() => opts || { postArgs: undefined, headers: undefined, cancellationToken: undefined }
		)();

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

		return this.invoke(webMethodName, "POST", { bodyBufferOrObject: body, headers: friendlyHeaders, cancellationToken });
	}

	protected async invoke(
		path: string,
		method: "GET" | "POST" | string,
		opts?: {
			headers?: http.OutgoingHttpHeaders,
			bodyBufferOrObject?: Buffer,
			cancellationToken?: CancellationTokenLike
		}): Promise<any> {
		super.verifyNotDisposed();

		const { bodyBufferOrObject, headers, cancellationToken } = (
			() => opts || { bodyBufferOrObject: undefined, headers: undefined, cancellationToken: undefined }
		)();

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
				limitToken = await this._limitHandle.instance.accrueTokenLazy(this._limitHandle.timeout || 500, cancellationToken);
			} else {
				limitToken = await this._limitHandle.instance.accrueTokenLazy(this._limitHandle.timeout || 500);
			}
		}
		try {
			const url: URL = new URL(path, this._baseUrl);

			const result: WebClientInvokeResult =
				await this._webClient.invoke({ url, method, body: friendlyBody, headers: friendlyHeaders }, cancellationToken);

			return result.body ? JSON.parse(result.body.toString()) : null;
		} finally {
			if (limitToken !== null) {
				limitToken.commit();
			}
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
