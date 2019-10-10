import * as http from "http";
import { URL } from "url";
import { assert } from "chai";
import { CancellationToken } from "@zxteam/contract";
import { DUMMY_CANCELLATION_TOKEN, ManualCancellationTokenSource } from "@zxteam/cancellation";
import { CancelledError } from "@zxteam/errors";

import { WebClient } from "../src/index";

describe("WebClient tests", function () {
	describe("Tests with limits", function () {
		class MyApiClient extends WebClient {
			public invoke(cancellationToken: CancellationToken, path: string, method: "GET" | "POST" | string, opts?: {
				headers?: http.OutgoingHttpHeaders
			}) {
				return super.invoke(cancellationToken, path, method, opts);
			}
		}

		it("MyApiClient GET should invoke http:// (with limit)", async function () {
			const apiClient = new MyApiClient("http://echo.org", {
				limit: {
					instance: { perSecond: 2, perMinute: 4, perHour: 50, parallel: 2 },
					timeout: 3000 // timeout for accure token
				},
				httpClient: {
					timeout: 1000 // timeout for web request
				}
			});
			const jobs: Array<Promise<void>> = [];
			const errors: Array<any> = [];
			let completeCount = 0;
			try {
				for (let index = 0; index < 10; index++) {
					jobs.push(
						apiClient.invoke(DUMMY_CANCELLATION_TOKEN, "a", "GET")
							.then(() => { ++completeCount; })
							.catch((reason: any) => { errors.push(reason); })
					);
				}
				await new Promise((r) => setTimeout(r, 2500));
				assert.equal(completeCount + errors.length, 4);
			} finally {
				await apiClient.dispose();
			}

			// 4 competed
			// 6 errors - Limit tiimeout
			assert.equal(completeCount + errors.length, 10);
		});

		it("MyApiClient GET should cancel() ", async function () {
			const apiClient = new MyApiClient(new URL("http://www.google.com"), {
				limit: {
					instance: { perSecond: 2, perMinute: 4, perHour: 50, parallel: 2 },
					timeout: 3000 // timeout for accure token
				},
				httpClient: {
					timeout: 1000 // timeout for web request
				}
			});
			const cts = new ManualCancellationTokenSource();
			const jobs: Array<Promise<void>> = [];
			const errors: Array<any> = [];
			let completeCount = 0;
			try {
				for (let index = 0; index < 10; index++) {
					jobs.push(
						apiClient.invoke(cts.token, "a", "GET")
							.then(() => { ++completeCount; })
							.catch((reason: any) => { errors.push(reason); })
					);
				}
				await new Promise((r) => setTimeout(r, 2500));
				assert.equal(completeCount + errors.length, 4);
				cts.cancel();
				await new Promise((r) => setTimeout(r, 25));
				assert.equal(completeCount + errors.length, 10);
				assert.isTrue(errors.length >= 6);
				errors.slice(errors.length - 6).forEach(e => assert.instanceOf(e, CancelledError));
			} finally {
				await apiClient.dispose();
			}
		});

		// [0, 1, 2, 3].forEach(i => {
		// 	it(`Stub ${i}`, async function () {
		// 		await new Promise((r) => setTimeout(r, 250));
		// 	});
		// });
	});
});
