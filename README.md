# ZXTeam's Web Client
[![npm version badge](https://img.shields.io/npm/v/@zxteam/web-client.svg)](https://www.npmjs.com/package/@zxteam/web-client)
[![downloads badge](https://img.shields.io/npm/dm/@zxteam/web-client.svg)](https://www.npmjs.org/package/@zxteam/web-client)
[![commit activity badge](https://img.shields.io/github/commit-activity/m/zxteamorg/node.web-client)](https://github.com/zxteamorg/node.web-client/pulse)
[![last commit badge](https://img.shields.io/github/last-commit/zxteamorg/node.web-client)](https://github.com/zxteamorg/node.web-client/graphs/commit-activity)
[![twitter badge](https://img.shields.io/twitter/follow/zxteamorg?style=social&logo=twitter)](https://twitter.com/zxteamorg)

### Examples (TypeScript)
#### [Simple HTTP request: test/examples/typescript/example001.ts](test/examples/typescript/example001.ts)
```typescript
const webClient = new WebClient("http://httpbin.org");
try {
	const response: WebClient.Response = await webClient.get(cancellationToken, "ip");

	const statusCode: number = response.statusCode;
	const statusMessage: string = response.statusMessage;
	const headers: http.IncomingHttpHeaders = response.headers;
	const body: Buffer = response.body;
	const bodyJson: any = response.bodyAsJson;

	console.log(statusCode);
	console.log(statusMessage);
	console.log(headers);
	console.log(body.toString());
	console.log(bodyJson);
} finally {
	await webClient.dispose();
}
```
