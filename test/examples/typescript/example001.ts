import * as zxteam from "@zxteam/contract";
// import { WebClient } from  "@zxteam/web-client";
import { WebClient } from "../../..";

import * as http from "http";

const cancellationToken: zxteam.CancellationToken = {
	isCancellationRequested: false,
	addCancelListener(cb: Function): void { /* dummy */ },
	removeCancelListener(cb: Function): void { /* dummy */ },
	throwIfCancellationRequested(): void { /* dummy */ }
};

async function main() {
	const webClient = new WebClient("http://httpbin.org");
	try {
		const response: WebClient.Response = await webClient.get(cancellationToken, "ip");

		const statusCode: number = response.statusCode;
		const statusDescription: string = response.statusDescription;
		const headers: http.IncomingHttpHeaders = response.headers;
		const body: Buffer = response.body;
		const bodyJson: any = response.bodyAsJson;

		console.log(statusCode);
		console.log(statusDescription);
		console.log(headers);
		console.log(body.toString());
		console.log(bodyJson);
	} finally {
		await webClient.dispose();
	}
}

main().catch(console.error);
