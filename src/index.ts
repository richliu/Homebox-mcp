#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load package.json for version info
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const VERSION = packageJson.version;

// Configuration interface
interface HomeboxConfig {
  homeboxUrl: string;
  email: string;
  password: string;
}

// Location node from GET /api/v1/entities/tree
interface TreeNode {
  id: string;
  name: string;
  type: string;
  children: TreeNode[];
}

// Flattened location returned by list_locations
interface FlatLocation {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
}

// Homebox API client.
// Homebox v0.26 merged items and locations into "entities" (entityType tells
// them apart) and renamed labels to "tags"; the old /items, /locations and
// /labels endpoints return 404. Tool names stay the same for MCP clients.
class HomeboxClient {
  private axios: AxiosInstance;
  private config: HomeboxConfig;
  private authToken: string | null = null;

  constructor(config: HomeboxConfig) {
    this.config = config;
    this.axios = axios.create({
      baseURL: config.homeboxUrl,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  async authenticate(): Promise<void> {
    try {
      const response = await this.axios.post("/api/v1/users/login", {
        username: this.config.email,
        password: this.config.password,
      });

      if (response.data && response.data.token) {
        this.authToken = response.data.token as string;
        // Newer Homebox returns the token with its "Bearer " prefix already
        this.axios.defaults.headers.common["Authorization"] = this.authToken.startsWith("Bearer ")
          ? this.authToken
          : `Bearer ${this.authToken}`;
      } else {
        throw new Error("Authentication failed: No token received");
      }
    } catch (error: any) {
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  async searchItems(query: string): Promise<any> {
    try {
      const result = await this.queryEntities([["q", query]]);
      // /entities only returns items; also report locations whose name matches
      const q = query.toLowerCase();
      const locations = (await this.flatLocations()).filter((l) =>
        l.name.toLowerCase().includes(q)
      );
      return { ...result, matchingLocations: locations };
    } catch (error: any) {
      throw new Error(`Failed to search items: ${error.message}`);
    }
  }

  async getItem(itemId: string): Promise<any> {
    try {
      return await this.getEntityWithPath(itemId);
    } catch (error: any) {
      throw new Error(`Failed to get item: ${error.message}`);
    }
  }

  async listLocations(): Promise<any> {
    try {
      return await this.flatLocations();
    } catch (error: any) {
      throw new Error(`Failed to list locations: ${error.message}`);
    }
  }

  async getLocation(locationId: string): Promise<any> {
    try {
      return await this.getEntityWithPath(locationId);
    } catch (error: any) {
      throw new Error(`Failed to get location: ${error.message}`);
    }
  }

  async listLabels(): Promise<any> {
    try {
      return await this.get("/api/v1/tags");
    } catch (error: any) {
      throw new Error(`Failed to list labels: ${error.message}`);
    }
  }

  async getLabel(labelId: string): Promise<any> {
    try {
      return await this.get(`/api/v1/tags/${labelId}`);
    } catch (error: any) {
      throw new Error(`Failed to get label: ${error.message}`);
    }
  }

  async getItemsByLocation(locationId: string, recursive = true): Promise<any> {
    try {
      const ids = [locationId];
      if (recursive) {
        const node = findNode(await this.locationTree(), locationId);
        if (node) {
          collectIds(node.children, ids);
        }
      }
      return await this.queryEntities(ids.map((id) => ["parentIds", id]));
    } catch (error: any) {
      throw new Error(`Failed to get items by location: ${error.message}`);
    }
  }

  async getItemsByLabel(labelId: string): Promise<any> {
    try {
      return await this.queryEntities([["tags", labelId]]);
    } catch (error: any) {
      throw new Error(`Failed to get items by label: ${error.message}`);
    }
  }

  // GET with login on first use and one re-login if the token has expired
  private async get(path: string, params?: URLSearchParams): Promise<any> {
    if (!this.authToken) {
      await this.authenticate();
    }
    try {
      return (await this.axios.get(path, { params })).data;
    } catch (error: any) {
      if (error.response?.status !== 401) {
        throw error;
      }
      await this.authenticate();
      return (await this.axios.get(path, { params })).data;
    }
  }

  // Item search; repeated keys (parentIds, tags) are OR-ed by Homebox
  private async queryEntities(params: [string, string][]): Promise<any> {
    const search = new URLSearchParams(params);
    search.set("pageSize", "-1");
    const data = await this.get("/api/v1/entities", search);
    return { total: data.total, items: data.items };
  }

  private async getEntityWithPath(id: string): Promise<any> {
    const [entity, path] = await Promise.all([
      this.get(`/api/v1/entities/${id}`),
      this.get(`/api/v1/entities/${id}/path`),
    ]);
    return { ...entity, path: path.map((p: any) => p.name).join(" / ") };
  }

  private async locationTree(): Promise<TreeNode[]> {
    return await this.get("/api/v1/entities/tree");
  }

  private async flatLocations(): Promise<FlatLocation[]> {
    const out: FlatLocation[] = [];
    const walk = (nodes: TreeNode[], parent: FlatLocation | null) => {
      for (const n of nodes) {
        const loc = {
          id: n.id,
          name: n.name,
          parentId: parent ? parent.id : null,
          path: parent ? `${parent.path} / ${n.name}` : n.name,
        };
        out.push(loc);
        walk(n.children || [], loc);
      }
    };
    walk(await this.locationTree(), null);
    return out;
  }
}

function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const n of nodes) {
    if (n.id === id) {
      return n;
    }
    const hit = findNode(n.children || [], id);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function collectIds(nodes: TreeNode[], ids: string[]): void {
  for (const n of nodes) {
    ids.push(n.id);
    collectIds(n.children || [], ids);
  }
}

// Load configuration from multiple sources
// Priority: 1. /config/config.json (Docker volume), 2. Environment variables, 3. ./config.json
function loadConfig(): HomeboxConfig {
  // Try Docker volume mount location first
  const dockerConfigPath = "/config/config.json";
  if (existsSync(dockerConfigPath)) {
    try {
      const configData = readFileSync(dockerConfigPath, "utf-8");
      const config = JSON.parse(configData);
      console.error("Loaded configuration from /config/config.json");
      return config;
    } catch (error: any) {
      console.error("Error loading /config/config.json:", error.message);
    }
  }

  // Try environment variables
  if (process.env.HOMEBOX_URL && process.env.HOMEBOX_EMAIL && process.env.HOMEBOX_PASSWORD) {
    console.error("Loaded configuration from environment variables");
    return {
      homeboxUrl: process.env.HOMEBOX_URL,
      email: process.env.HOMEBOX_EMAIL,
      password: process.env.HOMEBOX_PASSWORD,
    };
  }

  // Try local config.json
  const localConfigPath = join(__dirname, "..", "config.json");
  if (existsSync(localConfigPath)) {
    try {
      const configData = readFileSync(localConfigPath, "utf-8");
      const config = JSON.parse(configData);
      console.error("Loaded configuration from config.json");
      return config;
    } catch (error: any) {
      console.error("Error loading config.json:", error.message);
    }
  }

  // No configuration found
  console.error("Error: No configuration found!");
  console.error("Please provide configuration via one of:");
  console.error("  1. Environment variables: HOMEBOX_URL, HOMEBOX_EMAIL, HOMEBOX_PASSWORD");
  console.error("  2. /config/config.json (for Docker)");
  console.error("  3. config.json (copy from config.json.example)");
  process.exit(1);
}

// Define available tools
const TOOLS: Tool[] = [
  {
    name: "search_items",
    description: "Search for items in your Homebox inventory by name, description, or other fields. Returns matching items (each with its parent location) plus locations whose name matches.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find items",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_item",
    description: "Get detailed information about a specific item by its ID. Returns complete item details including name, description, location (parent and full path), tags, purchase info, warranty info, and more.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: {
          type: "string",
          description: "The ID of the item to retrieve",
        },
      },
      required: ["itemId"],
    },
  },
  {
    name: "list_locations",
    description: "List all locations in your Homebox inventory. Locations are where items are stored (e.g., 'Kitchen', 'Garage', 'Living Room'). Returns every location (nested ones included) with its ID, name, parent ID and full path (e.g. '書房 / 系統櫃下層').",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_location",
    description: "Get detailed information about a specific location by its ID, including its name, description, full path, parent location and child locations.",
    inputSchema: {
      type: "object",
      properties: {
        locationId: {
          type: "string",
          description: "The ID of the location to retrieve",
        },
      },
      required: ["locationId"],
    },
  },
  {
    name: "list_labels",
    description: "List all labels (called tags since Homebox v0.26) in your Homebox inventory. Labels are used to categorize items (e.g., 'Electronics', 'Important', 'Fragile'). Returns label names, IDs, and descriptions.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_label",
    description: "Get detailed information about a specific label by its ID, including its name, description, and color.",
    inputSchema: {
      type: "object",
      properties: {
        labelId: {
          type: "string",
          description: "The ID of the label to retrieve",
        },
      },
      required: ["labelId"],
    },
  },
  {
    name: "get_items_by_location",
    description: "Get all items stored in a specific location. Useful for finding everything in a particular room or storage area. Includes items in nested locations unless recursive is false.",
    inputSchema: {
      type: "object",
      properties: {
        locationId: {
          type: "string",
          description: "The ID of the location",
        },
        recursive: {
          type: "boolean",
          description: "Also include items in nested locations (default true)",
        },
      },
      required: ["locationId"],
    },
  },
  {
    name: "get_items_by_label",
    description: "Get all items that have a specific label. Useful for finding all items in a category (e.g., all electronics, all important items).",
    inputSchema: {
      type: "object",
      properties: {
        labelId: {
          type: "string",
          description: "The ID of the label",
        },
      },
      required: ["labelId"],
    },
  },
];

// Main server setup
async function main() {
  console.error("=".repeat(60));
  console.error("Homebox MCP Server v" + VERSION);
  console.error("=".repeat(60));
  console.error("Node version:", process.version);
  console.error("Platform:", process.platform);
  console.error("Build date:", new Date().toISOString());

  try {
    console.error("Loading configuration...");
    const config = loadConfig();
    console.error("Configuration loaded successfully");

    console.error("Creating Homebox client...");
    const homeboxClient = new HomeboxClient(config);

    // Test authentication on startup
    console.error("Attempting authentication with Homebox...");
    try {
      await homeboxClient.authenticate();
      console.error("Successfully authenticated with Homebox");
    } catch (error: any) {
      console.error("Failed to authenticate with Homebox:", error.message);
      console.error("Please check your config.json settings");
      process.exit(1);
    }

    console.error("Creating MCP Server instance...");
    const server = new Server(
      {
        name: "homebox-mcp-server",
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
    console.error("MCP Server instance created");

    console.error("Setting up request handlers...");
    // List available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      console.error("ListTools request received");
      return { tools: TOOLS };
    });

    // Handle tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.error("CallTool request received:", request.params.name);
      const { name } = request.params;
      // Tools without parameters may be called with no arguments object
      const args = request.params.arguments ?? {};

      try {
        switch (name) {
        case "search_items": {
          const result = await homeboxClient.searchItems(args.query as string);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "get_item": {
          const result = await homeboxClient.getItem(args.itemId as string);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "list_locations": {
          const result = await homeboxClient.listLocations();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "get_location": {
          const result = await homeboxClient.getLocation(args.locationId as string);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "list_labels": {
          const result = await homeboxClient.listLabels();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "get_label": {
          const result = await homeboxClient.getLabel(args.labelId as string);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "get_items_by_location": {
          const result = await homeboxClient.getItemsByLocation(
            args.locationId as string,
            args.recursive !== false
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case "get_items_by_label": {
          const result = await homeboxClient.getItemsByLabel(args.labelId as string);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
    });
    console.error("Request handlers configured");

    // Start the server
    console.error("Creating stdio transport...");
    const transport = new StdioServerTransport();
    console.error("Stdio transport created");

    console.error("Connecting server to transport...");
    await server.connect(transport);
    console.error("Homebox MCP Server running on stdio");
    console.error("Server is ready to accept requests");

  } catch (error: any) {
    console.error("Error in main():", error);
    console.error("Stack trace:", error.stack);
    throw error;
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  console.error("Error details:", JSON.stringify(error, null, 2));
  process.exit(1);
});
