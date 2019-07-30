const { name: packageName, version: packageVersion } = require(require("path").join(__dirname, "..", "package.json"));
const G: any = global || window || {};
const PACKAGE_GUARD: symbol = Symbol.for(packageName);
if (PACKAGE_GUARD in G) {
	const conflictVersion = G[PACKAGE_GUARD];
	// tslint:disable-next-line: max-line-length
	const msg = `Conflict module version. Look like two different version of package ${packageName} was loaded inside the process: ${conflictVersion} and ${packageVersion}.`;
	if (process !== undefined && process.env !== undefined && process.env.NODE_ALLOW_CONFLICT_MODULES === "1") {
		console.warn(msg + " This treats as warning because NODE_ALLOW_CONFLICT_MODULES is set.");
	} else {
		throw new Error(msg + " Use NODE_ALLOW_CONFLICT_MODULES=\"1\" to treats this error as warning.");
	}
} else {
	G[PACKAGE_GUARD] = packageVersion;
}

import * as zxteam from "@zxteam/contract";
import { Disposable, safeDispose } from "@zxteam/disposable";
import { HttpClient } from "@zxteam/http-client";
import { Limit, LimitToken, limitFactory } from "@zxteam/limit";

import * as http from "http";
import * as querystring from "querystring";
import { URL } from "url";

export namespace WebClient {
	export interface LimitOpts {
		instance: Limit.Opts | Limit;
		timeout: number;
	}

	export interface Opts {
		readonly httpClient?: HttpClient.Opts | HttpClient.InvokeChannel;
		readonly limit?: LimitOpts;
		readonly log?: zxteam.Logger;
		readonly userAgent?: string;
	}

	export interface Response extends HttpClient.Response {
		readonly bodyAsJson: any;
	}
}
export class WebClient extends Disposable {
	protected readonly _baseUrl: URL;
	protected readonly _log: zxteam.Logger;
	protected readonly _userAgent?: string;
	private readonly _httpClient: HttpClient.InvokeChannel;
	private readonly _httpClientRequiredDispose: boolean;
	private readonly _limitHandle?: { instance: Limit, timeout: number, isOwnInstance: boolean };

	public constructor(url: URL | string, opts?: WebClient.Opts) {
		super();
		this._baseUrl = typeof url === "string" ? new URL(url) : url;

		if (opts !== undefined && opts.log !== undefined) {
			this._log = opts.log;
		} else {
			this._log = DUMMY_LOGGER;
		}

		if (opts !== undefined) {
			const { limit, httpClient, userAgent } = opts;
			if (limit) {
				this._limitHandle = Limit.isLimitOpts(limit.instance) ?
					{
						instance: limitFactory(limit.instance), isOwnInstance: true, timeout: limit.timeout
					} : {
						instance: limit.instance, isOwnInstance: false, timeout: limit.timeout
					};
			}
			if (httpClient && "invoke" in httpClient) {
				this._httpClient = httpClient;
				this._httpClientRequiredDispose = false;
			} else {
				this._httpClient = new HttpClient(httpClient);
				this._httpClientRequiredDispose = false;
			}
			if (userAgent !== undefined) {
				this._userAgent = userAgent;
			}
		} else {
			this._httpClient = new HttpClient();
			this._httpClientRequiredDispose = false;
		}
	}

	public get(
		cancellationToken: zxteam.CancellationToken,
		webMethodName: string,
		opts?: {
			queryArgs?: { [key: string]: string },
			headers?: http.OutgoingHttpHeaders,
			limitWeight?: number
		}
	): Promise<WebClient.Response> {
		super.verifyNotDisposed();

		const { queryArgs = undefined, headers = undefined, limitWeight = undefined } = (() => opts || {})();
		const path = queryArgs !== undefined ?
			webMethodName + "?" + querystring.stringify(queryArgs) :
			webMethodName;

		return this.invoke(cancellationToken, path, "GET", { headers, limitWeight });
	}

	public postForm(
		cancellationToken: zxteam.CancellationToken,
		webMethodName: string,
		opts?: {
			postArgs?: { [key: string]: string },
			headers?: http.OutgoingHttpHeaders,
			limitWeight?: number
		}
	): Promise<WebClient.Response> {
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

		return this.invoke(cancellationToken, webMethodName, "POST", { body: body, headers: friendlyHeaders, limitWeight });
	}

	public async invoke(
		cancellationToken: zxteam.CancellationToken,
		path: string,
		method: HttpClient.HttpMethod | string,
		opts?: {
			headers?: http.OutgoingHttpHeaders,
			body?: Buffer | any,
			limitWeight?: number
		}): Promise<WebClient.Response> {
		super.verifyNotDisposed();

		let friendlyBody: Buffer | undefined = undefined;
		let friendlyHeaders: http.OutgoingHttpHeaders = {};
		let limitToken: LimitToken | null = null;
		let limitWeight: number | undefined = undefined;

		if (opts !== undefined) {
			const { headers, body } = opts;

			if (headers !== undefined) {
				friendlyHeaders = { ...headers };
			}

			if (this._userAgent !== undefined && !("User-Agent" in friendlyHeaders)) {
				friendlyHeaders["User-Agent"] = this._userAgent;
			}

			if (body !== undefined) {
				if (body instanceof Buffer) {
					friendlyBody = body;
				} else {
					// Serialize JSON if body is object
					friendlyBody = Buffer.from(JSON.stringify(body));
					if (!("Content-Type" in friendlyHeaders)) {
						friendlyHeaders["Content-Type"] = "application/json";
						friendlyHeaders["Content-Length"] = friendlyBody.byteLength;
					}
				}
			}

			if (opts.limitWeight !== undefined) {
				limitWeight = opts.limitWeight;
			}
		}

		try {
			if (this._limitHandle !== undefined) {
				const weight = limitWeight !== undefined ? limitWeight : 1;
				if (cancellationToken !== undefined) {
					limitToken = await this._limitHandle.instance.accrueTokenLazy(weight, this._limitHandle.timeout, cancellationToken);
				} else {
					limitToken = await this._limitHandle.instance.accrueTokenLazy(weight, this._limitHandle.timeout);
				}
			} else {
				if (limitWeight !== undefined) {
					friendlyHeaders["X-Limit-Weight"] = limitWeight;
				}
			}

			const url: URL = new URL(path, this._baseUrl);

			const invokeResponse: HttpClient.Response =
				await this._httpClient.invoke(cancellationToken, { url, method, body: friendlyBody, headers: friendlyHeaders });

			const { statusCode, statusMessage, headers: responseHeaders, body } = invokeResponse;

			const response: WebClient.Response = {
				get statusCode() { return statusCode; },
				get statusMessage() { return statusMessage; },
				get headers() { return responseHeaders; },
				get body() { return body; },
				get bodyAsJson() { return JSON.parse(invokeResponse.body.toString()); }
			};

			if (limitToken !== null) {
				limitToken.commit();
			}

			return response;
		} catch (e) {
			if (limitToken !== null) {
				if (e instanceof HttpClient.CommunicationError) {
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
		if (this._httpClientRequiredDispose) {
			// generally WebClientInvokeChannel is NOT disposable
			// but we do not know what implementation provider by client's web client factory
			// probably client's web client required to dispose()
			// so we trying to dispose safelly
			await safeDispose(this._httpClient);
		}
	}
}

export default WebClient;

const DUMMY_LOGGER: zxteam.Logger = Object.freeze({
	get isTraceEnabled(): boolean { return false; },
	get isDebugEnabled(): boolean { return false; },
	get isInfoEnabled(): boolean { return false; },
	get isWarnEnabled(): boolean { return false; },
	get isErrorEnabled(): boolean { return false; },
	get isFatalEnabled(): boolean { return false; },

	trace(message: string, ...args: any[]): void { /* NOP */ },
	debug(message: string, ...args: any[]): void { /* NOP */ },
	info(message: string, ...args: any[]): void { /* NOP */ },
	warn(message: string, ...args: any[]): void { /* NOP */ },
	error(message: string, ...args: any[]): void { /* NOP */ },
	fatal(message: string, ...args: any[]): void { /* NOP */ }
});
