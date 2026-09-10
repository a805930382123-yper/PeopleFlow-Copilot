import http from "node:http";
import { handleNodeApiRequest, initializeApi } from "./index.mjs";

const port = Number(process.env.API_PORT || 8787);
await initializeApi();
const server = http.createServer(handleNodeApiRequest);
server.listen(port, "127.0.0.1", () => console.log(`PeopleFlow API: http://localhost:${port}/api`));
