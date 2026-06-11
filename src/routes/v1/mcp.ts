/**
 * POST /mcp — MCP server endpoint (Model Context Protocol, stateless Streamable HTTP).
 *
 * Lets MCP clients (Claude Code, Claude Desktop, hosted agents) use MaluDB as long-term memory
 * with nothing but this URL and a Bearer token:
 *
 *     claude mcp add --transport http maludb http://localhost:8000/mcp \
 *       --header "Authorization: Bearer $TOKEN"
 *
 * Implements MCP spec 2025-06-18 in its simplest conformant shape:
 *   - Single endpoint, POST only (GET/DELETE -> 405).  Every JSON-RPC request gets a single
 *     application/json response; notifications get HTTP 202.  No sessions (no Mcp-Session-Id),
 *     no SSE, no JSON-RPC batches.
 *   - Methods: initialize, ping, tools/list, tools/call (+ notifications/*).
 *   - Auth: the same Bearer token flow as the REST API (resolveAuthContext); tools run as the
 *     token's user, so per-user LLM config applies.
 *   - Tool failures are JSON-RPC *successes* with isError:true and the standard
 *     {"error":{code,message}} JSON in the text block, so agents can read the error code and
 *     self-correct.  Protocol failures use JSON-RPC error codes.
 *
 * Eight tools: store_memory, search_memory, find_subjects, explore_subject, store_document,
 * get_document, find_skills, get_skill.  The pipeline tools call the shared cores exported by
 * the memory route files; the read tools carry their own literal SQL (copied from the
 * corresponding REST routes — see the repo's SQL-traceability principle).  The TOOLS registry
 * below is a cross-server contract ported byte-for-byte from the Python reference server.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveAuthContext } from '../../http/auth.js';
import { dbMany, dbOne } from '../../db/query.js';
import { dbTxCore } from '../../db/tx.js';
import { ApiError } from '../../http/errors.js';
import { classifyDatabaseError, pgErrorMessage } from '../../db/errors.js';
import { sendError } from '../../http/response.js';
import { ingestCore } from './memory_ingest.js';
import { searchCore } from './memory_search.js';
import { documentsCore } from './memory_documents.js';
import type { RequestCtx, Row } from '../../types/db.js';

const FILE = 'mcp.ts';

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSIONS = new Set(['2025-03-26', '2025-06-18']);
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'maludb', title: 'MaluDB Memory', version: SERVER_VERSION };

// ---------------------------------------------------------------------------
// Tool registry — names, schemas, and descriptions are a cross-server contract
// (ported verbatim from the Python reference server).  Plain data only.
// ---------------------------------------------------------------------------

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: boolean };
  annotations: typeof READ_ONLY | typeof WRITE;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'store_memory',
    title: 'Store memory',
    description:
      'Store a fact, event, or observation in MaluDB long-term memory. The server runs' +
      " LLM extraction (with the user's configured extract model) and writes subjects," +
      ' verbs, and edges into the knowledge graph. Call this whenever the user states' +
      ' something worth remembering. Pass hints for subjects you already know the text' +
      ' is about (use canonical names from find_subjects when possible).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to remember.' },
        hints: {
          type: 'array',
          description: 'Known subjects this text is about.',
          items: {
            type: 'object',
            properties: {
              subject_type: { type: 'string', description: 'e.g. person, project, software' },
              subject_name: { type: 'string' },
            },
            required: ['subject_type', 'subject_name'],
          },
        },
        namespace: { type: 'string', default: 'default' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: WRITE,
  },
  {
    name: 'search_memory',
    title: 'Search memory',
    description:
      'Semantic vector search over stored memory; returns matching text spans with' +
      ' their source document ids. The search requires a compartment pre-filter:' +
      ' pass subject (canonical name) and/or verb. Call find_subjects first when you' +
      " don't know the canonical subject name.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        subject: { type: 'string', description: 'Canonical subject name to search within.' },
        verb: { type: 'string', description: 'Canonical verb to search within.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        namespace: { type: 'string', default: 'default' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'find_subjects',
    title: 'Find subjects',
    description:
      'List canonical subjects (entities) in the memory graph, optionally filtered by' +
      ' a name/description substring. Call this before search_memory or' +
      " explore_subject when you don't know the exact canonical name.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to match against name or description.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'explore_subject',
    title: 'Explore subject',
    description:
      'Walk the knowledge graph around one subject: its edges and neighbors (depth 1)' +
      ' or multi-hop reach (depth 2-3). Use after find_subjects to see everything' +
      ' known about an entity.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Canonical subject name or numeric subject id.' },
        direction: { type: 'string', enum: ['out', 'in', 'both'], default: 'both' },
        verb: { type: 'string', description: 'Only follow edges with this verb.' },
        depth: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
      },
      required: ['subject'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'store_document',
    title: 'Store document',
    description:
      'Store a full document (meeting notes, transcript, article) in memory. The' +
      " server chunks the text, extracts graph edges with the user's configured" +
      ' model, embeds them, and links the document to the given subjects/projects.' +
      ' Prefer store_memory for short facts and observations.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        text: { type: 'string', description: 'The full document text.' },
        source_type: { type: 'string', default: 'document' },
        subjects: { type: 'array', items: { type: 'string' } },
        projects: { type: 'array', items: { type: 'string' } },
        namespace: { type: 'string', default: 'default' },
      },
      required: ['title', 'text'],
      additionalProperties: false,
    },
    annotations: WRITE,
  },
  {
    name: 'get_document',
    title: 'Get document',
    description:
      "Fetch one stored document's metadata and tags by id. Document ids come from" +
      ' search_memory results, store_memory, or store_document.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'integer' },
      },
      required: ['document_id'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'find_skills',
    title: 'Find skills',
    description:
      'Discover stored agent skills. Pass subject and/or verb for tag-aware ranked' +
      " discovery (e.g. verb='extract'); otherwise query matches names and" +
      ' descriptions. Call this when the current task might already have a stored' +
      ' skill.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        subject: { type: 'string' },
        verb: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: 'get_skill',
    title: 'Get skill',
    description:
      'Fetch one agent skill: metadata, the SKILL.md markdown instructions, and a' +
      ' listing of its bundle files (paths and sizes only — fetch full bundles via' +
      ' the REST API). Provide skill_id, or name to get the newest enabled version.',
    inputSchema: {
      type: 'object',
      properties: {
        skill_id: { type: 'integer' },
        name: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

type RpcId = string | number | null;

/** Handler-level parameter problem -> JSON-RPC -32602. */
class InvalidParams extends Error {}

/** An MCP tool result — one text content block, optionally flagged as a tool failure. */
interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function sendJson(reply: FastifyReply, status: number, payload: unknown): void {
  reply.code(status).header('content-type', 'application/json; charset=utf-8').send(payload);
}

function rpcResult(reply: FastifyReply, reqId: RpcId, result: unknown): void {
  sendJson(reply, 200, { jsonrpc: '2.0', id: reqId, result });
}

function rpcError(reply: FastifyReply, reqId: RpcId, code: number, message: string): void {
  sendJson(reply, 200, { jsonrpc: '2.0', id: reqId, error: { code, message } });
}

/** Serialize tool output like the REST API would (pg timestamps -> ISO-8601 strings). */
function textResult(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function errorResult(code: string, message: string, sqlstate?: string | null): ToolResult {
  const error: Record<string, string> = { code, message };
  if (sqlstate) error.sqlstate = sqlstate;
  return {
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Transport-level checks
// ---------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** DNS-rebinding guard: a present Origin must be localhost or our own host. Sends 403 if not. */
function originRejected(request: FastifyRequest, reply: FastifyReply): boolean {
  const origin = request.headers.origin;
  if (origin === undefined || origin === '') return false;
  let originHost = '';
  try {
    originHost = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    originHost = '';
  }
  const hostHeader = String(request.headers.host ?? '');
  const colon = hostHeader.lastIndexOf(':');
  const ownHost = (colon >= 0 ? hostHeader.slice(0, colon) : hostHeader)
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (LOCAL_HOSTS.has(originHost) || (ownHost !== '' && originHost === ownHost)) {
    return false;
  }
  sendError(reply, 'origin_forbidden', 'Origin not allowed.', 403);
  return true;
}

/** `MCP-Protocol-Version` header present but unsupported -> 400. */
function protocolVersionRejected(request: FastifyRequest, reply: FastifyReply): boolean {
  const version = request.headers['mcp-protocol-version'];
  if (typeof version === 'string' && version !== '' && !PROTOCOL_VERSIONS.has(version)) {
    sendError(
      reply,
      'unsupported_protocol_version',
      `Supported MCP protocol versions: ${[...PROTOCOL_VERSIONS].sort().join(', ')}.`,
      400,
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Argument coercion helpers (mirror the Python reference semantics)
// ---------------------------------------------------------------------------

type ToolArgs = Record<string, unknown>;

/** Python `str(args["x"]).strip() if args.get("x") and str(args["x"]).strip() else None`. */
function optStr(v: unknown): string | null {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Namespace default: `str(args.get("namespace") or "default").strip() or "default"`. */
function namespaceOf(v: unknown): string {
  return optStr(v) ?? 'default';
}

/** Integer argument with a default; non-numeric garbage -> -32602. */
function intArg(args: ToolArgs, key: string, def: number): number {
  const v = args[key];
  if (v === undefined || v === null) return def;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) {
    throw new InvalidParams(`"${key}" must be an integer.`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Tool handlers — (ctx, args) -> MCP result
// ---------------------------------------------------------------------------

async function toolStoreMemory(ctx: RequestCtx, args: ToolArgs): Promise<ToolResult> {
  const text = String(args.text ?? '');
  if (text.trim() === '') {
    throw new InvalidParams('"text" must be a non-empty string.');
  }
  const hintsJson = Array.isArray(args.hints) ? JSON.stringify(args.hints) : '[]';
  const namespace = namespaceOf(args.namespace);

  const payload = await ingestCore(ctx, {
    text,
    hintsJson,
    namespace,
    explicitModel: null,
    preview: false,
  });
  return textResult(payload);
}

async function toolSearchMemory(ctx: RequestCtx, args: ToolArgs): Promise<ToolResult> {
  const query = String(args.query ?? '');
  if (query.trim() === '') {
    throw new InvalidParams('"query" must be a non-empty string.');
  }
  const subject = optStr(args.subject);
  const verb = optStr(args.verb);
  const limit = Math.max(1, Math.min(50, intArg(args, 'limit', 10)));
  const namespace = namespaceOf(args.namespace);

  if (subject === null && verb === null) {
    // The compartment pre-filter is required; instead of a bare 400, return
    // the matching subjects so the agent can pick one and retry.
    const split = query.split(/\s+/).filter((t) => t.length >= 3);
    const terms = split.length > 0 ? split : [query.trim()];
    const rows = await dbMany(
      ctx,
      `SELECT canonical_name AS name, subject_type AS type
         FROM maludb_subject
        WHERE canonical_name ILIKE ANY($1)
        ORDER BY canonical_name
        LIMIT 10`,
      [terms.map((t) => `%${t}%`)],
    );
    const matches = rows.map((r) => `${r.name} (${r.type})`).join(', ') || 'none';
    return errorResult(
      'missing_field',
      'Provide subject and/or verb — the compartment pre-filter is required.' +
        ` Known subjects matching your query: ${matches}.` +
        ' Pick one or call find_subjects.',
    );
  }

  const payload = await searchCore(ctx, {
    query,
    subject,
    verb,
    namespace,
    limit,
    metric: 'cosine',
    embeddingModel: null,
  });
  return textResult(payload);
}

async function toolFindSubjects(ctx: RequestCtx, args: ToolArgs): Promise<ToolResult> {
  const q = optStr(args.query);
  const limit = Math.max(1, Math.min(200, intArg(args, 'limit', 25)));

  let where = '';
  const params: unknown[] = [];
  if (q !== null) {
    where = 'WHERE s.canonical_name ILIKE $1 OR s.description ILIKE $2';
    params.push(`%${q}%`, `%${q}%`);
  }
  params.push(limit);

  const sql = `SELECT s.subject_id     AS id,
                      s.canonical_name AS name,
                      s.subject_type   AS type,
                      s.description
                 FROM maludb_subject s
                 ${where}
                ORDER BY s.canonical_name
                LIMIT $${params.length}`;

  const rows = await dbMany(ctx, sql, params);
  for (const r of rows) {
    r.id = Number(r.id);
  }
  return textResult({ subjects: rows });
}

/** Resolve a subject reference (numeric id or canonical name) to a row. */
async function resolveSubject(ctx: RequestCtx, ref: string): Promise<Row> {
  ref = ref.trim();
  if (ref === '') {
    throw new InvalidParams('"subject" must be a non-empty string.');
  }

  const base =
    'SELECT subject_id AS id, canonical_name AS name, subject_type AS type FROM maludb_subject';
  if (/^\d+$/.test(ref)) {
    const byId = await dbOne(ctx, `${base} WHERE subject_id = $1`, [Number(ref)]);
    if (byId === null) {
      throw new ApiError('not_found', `No subject with id ${ref}.`, 404);
    }
    byId.id = Number(byId.id);
    return byId;
  }

  let row = await dbOne(ctx, `${base} WHERE canonical_name = $1`, [ref]);
  if (row === null) {
    const candidates = await dbMany(
      ctx,
      `${base} WHERE canonical_name ILIKE $1 ORDER BY canonical_name LIMIT 6`,
      [`%${ref}%`],
    );
    if (candidates.length === 1) {
      row = candidates[0] ?? null;
    } else if (candidates.length === 0) {
      throw new ApiError('not_found', `No subject matching "${ref}". Call find_subjects.`, 404);
    } else {
      const names = candidates.map((c) => c.name).join(', ');
      throw new ApiError(
        'ambiguous_subject',
        `Multiple subjects match "${ref}": ${names}. Pick one exact canonical name.`,
        422,
      );
    }
  }
  row!.id = Number(row!.id);
  return row!;
}

async function toolExploreSubject(ctx: RequestCtx, args: ToolArgs): Promise<ToolResult> {
  const subject = await resolveSubject(ctx, String(args.subject ?? ''));
  const direction = String(args.direction ?? 'both').trim().toLowerCase() || 'both';
  if (direction !== 'out' && direction !== 'in' && direction !== 'both') {
    throw new InvalidParams('"direction" must be one of: out, in, both.');
  }
  const depth = Math.max(1, Math.min(3, intArg(args, 'depth', 1)));
  const verb = optStr(args.verb);
  const relList = verb !== null ? [verb] : null;

  if (depth === 1) {
    const rows = await dbTxCore(ctx, async () => {
      let sql: string;
      let params: unknown[];
      if (relList !== null) {
        sql = `SELECT neighbor_kind, neighbor_id, rel, edge_store,
                      confidence, provenance, label
                 FROM maludb_graph_neighbors($1, $2, $3, $4::text[])`;
        params = ['subject', subject.id, direction, relList];
      } else {
        sql = `SELECT neighbor_kind, neighbor_id, rel, edge_store,
                      confidence, provenance, label
                 FROM maludb_graph_neighbors($1, $2, $3)`;
        params = ['subject', subject.id, direction];
      }
      const out = await dbMany(ctx, sql, params);
      for (const r of out) {
        r.neighbor_id = Number(r.neighbor_id);
        r.confidence = r.confidence === null ? null : Number(r.confidence);
      }
      return out;
    });
    return textResult({ subject, direction, depth, neighbors: rows });
  }

  const rows = await dbTxCore(ctx, async () => {
    let sql: string;
    let params: unknown[];
    if (relList !== null) {
      sql = `SELECT object_kind, object_id, depth, rel, edge_store, label, path
               FROM maludb_graph_walk($1, $2, $3, $4, $5::text[])`;
      params = ['subject', subject.id, depth, direction, relList];
    } else {
      sql = `SELECT object_kind, object_id, depth, rel, edge_store, label, path
               FROM maludb_graph_walk($1, $2, $3, $4)`;
      params = ['subject', subject.id, depth, direction];
    }
    const out = await dbMany(ctx, sql, params);
    for (const r of out) {
      r.object_id = Number(r.object_id);
      r.depth = Number(r.depth);
      if (r.path === null) r.path = [];
    }
    return out;
  });
  return textResult({ subject, direction, depth, walk: rows });
}

async function toolStoreDocument(ctx: RequestCtx, args: ToolArgs): Promise<ToolResult> {
  const title = String(args.title ?? '').trim();
  const text = String(args.text ?? '');
  if (title === '') {
    throw new InvalidParams('"title" must be a non-empty string.');
  }
  if (text.trim() === '') {
    throw new InvalidParams('"text" must be a non-empty string.');
  }

  const strings = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
      : [];

  const payload = await documentsCore(ctx, {
    title,
    text,
    sourceType: optStr(args.source_type) ?? 'document',
    mediaType: null,
    documentType: null,
    metadataJson: JSON.stringify({ source: 'mcp' }),
    projects: strings(args.projects),
    subjects: strings(args.subjects),
    verbs: [],
    events: [],
    chunkMax: 2000,
    chunkOverlap: 200,
    embeddingModel: null,
    explicitModel: null,
    providedEdges: null,
    namespace: namespaceOf(args.namespace),
  });
  return textResult(payload);
}

async function toolGetDocument(ctx: RequestCtx, args: ToolArgs): Promise<ToolResult> {
  const documentId = Math.trunc(Number(args.document_id));
  if (!Number.isFinite(documentId)) {
    throw new InvalidParams('"document_id" must be an integer.');
  }

  const doc = await dbOne(
    ctx,
    `SELECT d.document_id              AS id,
            d.title,
            d.source_type,
            d.media_type,
            d.document_type,
            d.primary_project_id,
            d.metadata_jsonb->>'description' AS description,
            sp.content_size,
            sp.content_hash,
            d.created_at,
            d.updated_at
       FROM maludb_document d
       LEFT JOIN maludb_source_package sp ON sp.source_package_id = d.source_package_id
      WHERE d.document_id = $1`,
    [documentId],
  );
  if (doc === null) {
    throw new ApiError('not_found', 'Document not found.', 404);
  }
  doc.id = Number(doc.id);
  doc.content_size = doc.content_size === null ? null : Number(doc.content_size);
  doc.primary_project_id =
    doc.primary_project_id === null ? null : Number(doc.primary_project_id);

  const tags = await dbMany(
    ctx,
    `SELECT tag_id, tag_kind, tag_value, tag_object_type, tag_object_id, provenance, confidence
       FROM maludb_document_tag
      WHERE document_id = $1
      ORDER BY tag_kind, tag_value, tag_id`,
    [documentId],
  );
  for (const t of tags) {
    t.tag_id = Number(t.tag_id);
    t.tag_object_id = t.tag_object_id === null ? null : Number(t.tag_object_id);
    t.confidence = t.confidence === null ? null : Number(t.confidence);
  }
  doc.tags = tags;

  return textResult({ document: doc });
}

async function toolFindSkills(ctx: RequestCtx, args: ToolArgs): Promise<ToolResult> {
  const q = optStr(args.query);
  const subject = optStr(args.subject);
  const verb = optStr(args.verb);
  const limit = Math.max(1, Math.min(200, intArg(args, 'limit', 20)));

  if (subject !== null || verb !== null) {
    const rows = await dbMany(
      ctx,
      `SELECT owner_schema, skill_id AS id, skill_name AS name, description,
              version, visibility, subjects, verbs, keywords, score,
              match_reasons, is_public, is_forkable,
              source_owner_schema, source_skill_id, updated_at
         FROM maludb_skill_search($1, $2, $3, NULL, $4)`,
      [q, subject, verb, limit],
    );
    for (const r of rows) {
      r.id = Number(r.id);
      r.score = r.score === null ? null : Number(r.score);
      if (r.source_skill_id !== null) {
        r.source_skill_id = Number(r.source_skill_id);
      }
    }
    return textResult({ skills: rows });
  }

  let where = '';
  const params: unknown[] = [];
  if (q !== null) {
    where = 'WHERE (skill_name ILIKE $1 OR description ILIKE $2)';
    params.push(`%${q}%`, `%${q}%`);
  }
  params.push(limit);

  const sql = `SELECT skill_id AS id, skill_name AS name, description, version,
                      visibility, packaging_kind, enabled, created_at
                 FROM maludb_skill
                 ${where}
                ORDER BY skill_name
                LIMIT $${params.length}`;

  const rows = await dbMany(ctx, sql, params);
  for (const r of rows) {
    r.id = Number(r.id);
    r.enabled = r.enabled === null ? null : Boolean(r.enabled);
  }
  return textResult({ skills: rows });
}

async function toolGetSkill(ctx: RequestCtx, args: ToolArgs): Promise<ToolResult> {
  const name = optStr(args.name);
  let skillId: number;
  if (args.skill_id === undefined || args.skill_id === null) {
    if (name === null) {
      throw new InvalidParams('Provide "skill_id" or "name".');
    }
    const row = await dbOne(
      ctx,
      `SELECT skill_id FROM maludb_skill
        WHERE skill_name = $1 AND (enabled IS DISTINCT FROM FALSE)
        ORDER BY skill_id DESC LIMIT 1`,
      [name],
    );
    if (row === null) {
      throw new ApiError('not_found', `No enabled skill named "${name}".`, 404);
    }
    skillId = Number(row.skill_id);
  } else {
    skillId = Math.trunc(Number(args.skill_id));
    if (!Number.isFinite(skillId)) {
      throw new InvalidParams('"skill_id" must be an integer.');
    }
  }

  const skill = await dbOne(
    ctx,
    `SELECT skill_id AS id, skill_name AS name, description, markdown, version,
            visibility, enabled, bundle_hash, frontmatter_jsonb,
            source_owner_schema, source_skill_id, created_at
       FROM maludb_skill WHERE skill_id = $1`,
    [skillId],
  );
  if (skill === null) {
    throw new ApiError('not_found', 'Skill not found.', 404);
  }
  skill.id = Number(skill.id);
  if (skill.source_skill_id !== null) {
    skill.source_skill_id = Number(skill.source_skill_id);
  }
  skill.enabled = skill.enabled === null ? null : Boolean(skill.enabled);

  // Listing only — no maludb_source_package join, so file contents never load.
  const files = await dbMany(
    ctx,
    `SELECT relative_path, file_size, media_type
       FROM maludb_skill_file
      WHERE skill_id = $1
      ORDER BY relative_path`,
    [skillId],
  );
  for (const f of files) {
    f.file_size = f.file_size === null ? null : Number(f.file_size);
  }

  return textResult({ skill, files });
}

const TOOL_HANDLERS: Record<string, (ctx: RequestCtx, args: ToolArgs) => Promise<ToolResult>> = {
  store_memory: toolStoreMemory,
  search_memory: toolSearchMemory,
  find_subjects: toolFindSubjects,
  explore_subject: toolExploreSubject,
  store_document: toolStoreDocument,
  get_document: toolGetDocument,
  find_skills: toolFindSkills,
  get_skill: toolGetSkill,
};

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

function handleInitialize(params: Record<string, unknown>): Record<string, unknown> {
  const requested = params.protocolVersion;
  const version =
    typeof requested === 'string' && PROTOCOL_VERSIONS.has(requested)
      ? requested
      : DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
  };
}

async function handleToolsCall(
  ctx: RequestCtx,
  params: Record<string, unknown>,
  reqId: RpcId,
  reply: FastifyReply,
): Promise<void> {
  const name = params.name;
  if (typeof name !== 'string' || !(name in TOOL_HANDLERS)) {
    rpcError(reply, reqId, -32602, `Unknown tool: ${JSON.stringify(name ?? null)}`);
    return;
  }

  const rawArgs = params.arguments;
  const args: ToolArgs =
    rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as ToolArgs)
      : {};
  const schema = TOOLS_BY_NAME.get(name)!.inputSchema;
  for (const reqField of schema.required ?? []) {
    if (!(reqField in args) || args[reqField] === null || args[reqField] === undefined) {
      rpcError(reply, reqId, -32602, `Missing required argument "${reqField}" for tool "${name}".`);
      return;
    }
  }

  let result: ToolResult;
  try {
    result = await TOOL_HANDLERS[name]!(ctx, args);
  } catch (err) {
    if (err instanceof InvalidParams) {
      rpcError(reply, reqId, -32602, err.message);
      return;
    }
    if (err instanceof ApiError) {
      result = errorResult(err.code, err.message);
    } else if (typeof (err as { code?: unknown } | null)?.code === 'string' &&
        /^[0-9A-Z]{5}$/.test((err as { code: string }).code)) {
      // A Postgres error (node-pg surfaces the SQLSTATE on err.code).
      const { code, sqlstate } = classifyDatabaseError(err);
      result = errorResult(code, pgErrorMessage((err as Error).message ?? ''), sqlstate);
    } else {
      throw err;
    }
  }
  rpcResult(reply, reqId, result);
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

async function mcpPost(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (originRejected(request, reply) || protocolVersionRejected(request, reply)) {
    return;
  }

  // Same Bearer flow as REST; ApiError(401) propagates to the Fastify error handler.
  // (Tenant Postgres connections are pooled per-process — nothing to close per request.)
  const ctx = resolveAuthContext(request.headers.authorization, FILE);
  ctx.method = request.method;
  ctx.path = request.url;
  (request as FastifyRequest & { ctx?: RequestCtx }).ctx = ctx;

  // Manual body parse (the route-scoped content-type parser passes the raw string through), so a
  // malformed body is a JSON-RPC -32700 response — not the transport-level 400 the REST API uses.
  const raw = request.body;
  let msg: unknown;
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : '');
  } catch {
    rpcError(reply, null, -32700, 'Parse error');
    return;
  }

  if (Array.isArray(msg)) {
    rpcError(reply, null, -32600, 'Batch requests are not supported (MCP 2025-06-18).');
    return;
  }
  if (msg === null || typeof msg !== 'object' || (msg as Record<string, unknown>).jsonrpc !== '2.0') {
    rpcError(reply, null, -32600, 'Invalid request: expected a JSON-RPC 2.0 object.');
    return;
  }
  const m = msg as Record<string, unknown>;
  const method = m.method;
  if (typeof method !== 'string' || method === '') {
    rpcError(reply, (m.id as RpcId) ?? null, -32600, 'Invalid request: "method" is required.');
    return;
  }

  // Notifications (no id) are accepted and ignored.
  if (!Object.prototype.hasOwnProperty.call(m, 'id')) {
    reply.code(202).send();
    return;
  }

  const reqId = (m.id as RpcId) ?? null;
  const params =
    m.params !== null && typeof m.params === 'object' && !Array.isArray(m.params)
      ? (m.params as Record<string, unknown>)
      : {};

  if (method === 'initialize') {
    rpcResult(reply, reqId, handleInitialize(params));
    return;
  }
  if (method === 'ping') {
    rpcResult(reply, reqId, {});
    return;
  }
  if (method === 'tools/list') {
    rpcResult(reply, reqId, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    await handleToolsCall(ctx, params, reqId, reply);
    return;
  }
  rpcError(reply, reqId, -32601, `Method not found: ${method}`);
}

function mcpMethodNotAllowed(_request: FastifyRequest, reply: FastifyReply): void {
  reply.header('Allow', 'POST');
  sendError(reply, 'method_not_allowed', 'MCP requires POST. SSE streaming is not supported.', 405);
}

export async function register(app: FastifyInstance): Promise<void> {
  // Encapsulated scope: /mcp gets a raw-passthrough JSON parser (the handler json-parses the body
  // itself so a malformed body becomes a JSON-RPC -32700, not the app-wide 400 body_invalid_json).
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_req, body, done) => {
        done(null, body);
      },
    );
    scope.route({ method: ['POST'], url: '/mcp', handler: mcpPost });
    scope.route({ method: ['GET', 'DELETE'], url: '/mcp', handler: mcpMethodNotAllowed });
  });
}
