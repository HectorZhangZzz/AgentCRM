import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { api, loadClientConfig, applicationVersion } from "./config.mjs";

try {
  const client = loadClientConfig();
  const catalog = await api(client, "/api/v1/tools");
  const server = new McpServer({
    name: "agent-crm",
    version: applicationVersion,
  });
  for (const tool of catalog.tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema),
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.name === "crm_reassign",
          openWorldHint: false,
        },
      },
      async (args) => {
        try {
          const result = await api(
            client,
            "/api/v1/tools/" + encodeURIComponent(tool.name),
            args,
          );
          if (tool.name === "crm_material" && args.includeContent) {
            const content = result.content || result;
            const material = result.material || result;
            if (
              content.base64 &&
              ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
                material.mimeType,
              ) &&
              content.base64.length < 12 * 1024 * 1024
            ) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      ...result,
                      content: { ...content, base64: "[image block]" },
                    }),
                  },
                  {
                    type: "image",
                    data: content.base64,
                    mimeType: material.mimeType,
                  },
                ],
              };
            }
          }
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: {
                    code: error.code || "CONNECTION",
                    message: error.message,
                    details: error.details,
                  },
                }),
              },
            ],
          };
        }
      },
    );
  }
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error("Agent CRM MCP 无法启动：" + error.message);
  process.exitCode = 1;
}
