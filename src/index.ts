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
import { basename } from "path";
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

  // ---- write operations -------------------------------------------------

  async createItem(input: ItemFields & { name: string }): Promise<any> {
    try {
      const created = await this.request("post", "/api/v1/entities", {
        name: input.name,
        description: input.description ?? "",
        quantity: input.quantity ?? 1,
        parentId: input.locationId,
        tagIds: input.tagIds ?? [],
        entityTypeId: await this.entityTypeId(false),
      });
      // EntityCreate has no manufacturer/model/serial/notes; set them with an update
      const extra = { ...input } as any;
      for (const k of ["name", "description", "quantity", "locationId", "tagIds"]) {
        delete extra[k];
      }
      if (Object.values(extra).some((v) => v !== undefined)) {
        await this.updateEntity(created.id, extra);
      }
      return await this.getEntityWithPath(created.id);
    } catch (error: any) {
      throw new Error(`Failed to create item: ${describe(error)}`);
    }
  }

  async updateItem(itemId: string, changes: ItemFields & { name?: string; archived?: boolean }): Promise<any> {
    try {
      await this.updateEntity(itemId, changes);
      return await this.getEntityWithPath(itemId);
    } catch (error: any) {
      throw new Error(`Failed to update item: ${describe(error)}`);
    }
  }

  async moveItem(itemId: string, locationId: string): Promise<any> {
    try {
      await this.request("patch", `/api/v1/entities/${itemId}`, { id: itemId, parentId: locationId });
      return await this.getEntityWithPath(itemId);
    } catch (error: any) {
      throw new Error(`Failed to move item: ${describe(error)}`);
    }
  }

  async deleteItem(itemId: string): Promise<any> {
    try {
      const entity = await this.getEntityWithPath(itemId);
      await this.request("delete", `/api/v1/entities/${itemId}`);
      return { deleted: true, id: itemId, name: entity.name, path: entity.path };
    } catch (error: any) {
      throw new Error(`Failed to delete item: ${describe(error)}`);
    }
  }

  async uploadPhoto(itemId: string, filePath: string, primary = true): Promise<any> {
    try {
      const name = basename(filePath);
      const form = new FormData();
      form.append("file", new Blob([readFileSync(filePath)], { type: mimeType(name) }), name);
      form.append("name", name);
      form.append("type", "photo");
      form.append("primary", String(primary));
      await this.request("post", `/api/v1/entities/${itemId}/attachments`, form);
      const entity = await this.get(`/api/v1/entities/${itemId}`);
      return { id: itemId, name: entity.name, imageId: entity.imageId, attachments: entity.attachments?.length ?? 0 };
    } catch (error: any) {
      throw new Error(`Failed to upload photo: ${describe(error)}`);
    }
  }

  async createLocation(name: string, parentId?: string, description?: string): Promise<any> {
    try {
      const created = await this.request("post", "/api/v1/entities", {
        name,
        description: description ?? "",
        parentId,
        entityTypeId: await this.entityTypeId(true),
      });
      return await this.getEntityWithPath(created.id);
    } catch (error: any) {
      throw new Error(`Failed to create location: ${describe(error)}`);
    }
  }

  async createLabel(name: string, description?: string): Promise<any> {
    try {
      return await this.request("post", "/api/v1/tags", { name, description: description ?? "" });
    } catch (error: any) {
      throw new Error(`Failed to create label: ${describe(error)}`);
    }
  }

  // PUT replaces every field, so start from the current entity and overlay changes
  private async updateEntity(id: string, changes: Record<string, any>): Promise<void> {
    const e = await this.get(`/api/v1/entities/${id}`);
    const body: Record<string, any> = {
      id,
      name: e.name,
      description: e.description,
      quantity: e.quantity,
      archived: e.archived,
      assetId: e.assetId,
      insured: e.insured,
      lifetimeWarranty: e.lifetimeWarranty,
      manufacturer: e.manufacturer,
      modelNumber: e.modelNumber,
      serialNumber: e.serialNumber,
      notes: e.notes,
      purchaseDate: e.purchaseDate || null,
      purchaseFrom: e.purchaseFrom,
      purchasePrice: e.purchasePrice,
      soldDate: e.soldDate || null,
      soldNotes: e.soldNotes,
      soldPrice: e.soldPrice,
      soldTo: e.soldTo,
      warrantyDetails: e.warrantyDetails,
      warrantyExpires: e.warrantyExpires || null,
      syncChildEntityLocations: e.syncChildEntityLocations,
      fields: e.fields ?? [],
      entityTypeId: e.entityType?.id,
      parentId: e.parent?.id ?? null,
      tagIds: (e.tags ?? []).map((t: any) => t.id),
    };
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined) {
        continue;
      }
      body[k === "locationId" ? "parentId" : k] = v;
    }
    await this.request("put", `/api/v1/entities/${id}`, body);
  }

  private async entityTypeId(isLocation: boolean): Promise<string> {
    const types: any[] = await this.get("/api/v1/entity-types");
    const t = types.find((x) => x.isLocation === isLocation);
    if (!t) {
      throw new Error(`no ${isLocation ? "location" : "item"} entity type in Homebox`);
    }
    return t.id;
  }

  // Non-GET request with the same login / re-login handling as get()
  private async request(method: "post" | "put" | "patch" | "delete", path: string, data?: any): Promise<any> {
    if (!this.authToken) {
      await this.authenticate();
    }
    // FormData must set its own multipart Content-Type
    const headers = data instanceof FormData ? { "Content-Type": undefined as any } : undefined;
    const send = () => this.axios.request({ method, url: path, data, headers });
    try {
      return (await send()).data;
    } catch (error: any) {
      if (error.response?.status !== 401) {
        throw error;
      }
      await this.authenticate();
      return (await send()).data;
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

// Optional item fields shared by create_item and update_item
interface ItemFields {
  description?: string;
  quantity?: number;
  locationId?: string;
  tagIds?: string[];
  manufacturer?: string;
  modelNumber?: string;
  serialNumber?: string;
  notes?: string;
}

function mimeType(name: string): string {
  const ext = name.toLowerCase().split(".").pop();
  const types: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic",
  };
  return types[ext ?? ""] ?? "application/octet-stream";
}

// Include Homebox's own error message (e.g. validation details) when there is one
function describe(error: any): string {
  const body = error.response?.data;
  const detail = typeof body === "string" ? body : body?.error ?? body?.message;
  return detail ? `${error.message}: ${detail}` : error.message;
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
  {
    name: "create_item",
    description: "Create a new item. Returns the created item with its ID and full location path. Writes to the inventory: only call after the user has confirmed the details.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Item name" },
        description: { type: "string", description: "Free-text description" },
        quantity: { type: "number", description: "How many (default 1 on create)" },
        locationId: { type: "string", description: "ID of the location the item is stored in (see list_locations)" },
        tagIds: { type: "array", items: { type: "string" }, description: "Label/tag IDs (see list_labels); on update this replaces the existing tags" },
        manufacturer: { type: "string", description: "Brand / manufacturer" },
        modelNumber: { type: "string", description: "Model number" },
        serialNumber: { type: "string", description: "Serial number" },
        notes: { type: "string", description: "Notes" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_item",
    description: "Change fields of an existing item; fields left out keep their current value. Set archived to true to archive (soft-delete) an item, false to restore it. Writes to the inventory: only call after the user has confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The ID of the item to change" },
        name: { type: "string", description: "New item name" },
        archived: { type: "boolean", description: "true archives the item (hidden from normal lists, data and photos kept), false restores it" },
        description: { type: "string", description: "Free-text description" },
        quantity: { type: "number", description: "How many (default 1 on create)" },
        locationId: { type: "string", description: "ID of the location the item is stored in (see list_locations)" },
        tagIds: { type: "array", items: { type: "string" }, description: "Label/tag IDs (see list_labels); on update this replaces the existing tags" },
        manufacturer: { type: "string", description: "Brand / manufacturer" },
        modelNumber: { type: "string", description: "Model number" },
        serialNumber: { type: "string", description: "Serial number" },
        notes: { type: "string", description: "Notes" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "move_item",
    description: "Move an item (or a location) to another location. Writes to the inventory: only call after the user has confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The ID of the item to move" },
        locationId: { type: "string", description: "The ID of the destination location" },
      },
      required: ["itemId", "locationId"],
    },
  },
  {
    name: "delete_item",
    description: "PERMANENTLY delete an item together with its photos and attachments; it cannot be undone. Prefer update_item with archived=true. Only call when the user has explicitly asked for permanent deletion and confirmed the exact item.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The ID of the item to delete" },
      },
      required: ["itemId"],
    },
  },
  {
    name: "upload_photo",
    description: "Attach a photo from a local file on the MCP server's machine to an item, by default as its primary (cover) image.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "The ID of the item" },
        filePath: { type: "string", description: "Absolute path of the image file (jpg, png, webp, gif, heic)" },
        primary: { type: "boolean", description: "Use as the item's primary image (default true)" },
      },
      required: ["itemId", "filePath"],
    },
  },
  {
    name: "create_location",
    description: "Create a new location, optionally nested inside another one (e.g. a box inside a cabinet). Writes to the inventory: only call after the user has confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Location name" },
        parentId: { type: "string", description: "ID of the parent location; omit for a top-level location" },
        description: { type: "string", description: "Free-text description" },
      },
      required: ["name"],
    },
  },
  {
    name: "create_label",
    description: "Create a new label (tag). Writes to the inventory: only call after the user has confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Label name" },
        description: { type: "string", description: "Free-text description" },
      },
      required: ["name"],
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

        case "create_item":
        case "update_item":
        case "move_item":
        case "delete_item":
        case "upload_photo":
        case "create_location":
        case "create_label": {
          const a = args as any;
          const fields = {
            description: a.description,
            quantity: a.quantity,
            locationId: a.locationId,
            tagIds: a.tagIds,
            manufacturer: a.manufacturer,
            modelNumber: a.modelNumber,
            serialNumber: a.serialNumber,
            notes: a.notes,
          };
          const result =
            name === "create_item" ? await homeboxClient.createItem({ ...fields, name: a.name }) :
            name === "update_item" ? await homeboxClient.updateItem(a.itemId, { ...fields, name: a.name, archived: a.archived }) :
            name === "move_item" ? await homeboxClient.moveItem(a.itemId, a.locationId) :
            name === "delete_item" ? await homeboxClient.deleteItem(a.itemId) :
            name === "upload_photo" ? await homeboxClient.uploadPhoto(a.itemId, a.filePath, a.primary !== false) :
            name === "create_location" ? await homeboxClient.createLocation(a.name, a.parentId, a.description) :
            await homeboxClient.createLabel(a.name, a.description);
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
