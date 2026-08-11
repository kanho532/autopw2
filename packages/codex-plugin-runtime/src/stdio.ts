import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPluginServer } from "./server.js";

const server = createPluginServer();
await server.connect(new StdioServerTransport());
