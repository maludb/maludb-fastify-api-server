# MaluDB API v1 — Endpoint Map

Every `/v1/...` URL maps to exactly one route file in `src/routes/v1/` (same name as the PHP
source file, `.ts` extension). This catalog is the porting checklist: URL → file → methods → exact
MaluDB SQL objects → request/response shape → the MaluDB concept it teaches. Ported faithfully from
`maludb/maludb-lamp-api-server`. A `✅` in a family heading is added as that family is ported.

> `/v1/health` has no PHP source file (the PHP health/diag lives outside `v1`); it is added fresh
> in the TS server as an unauthenticated liveness probe.

## Subjects

### `GET POST` /v1/subjects   → `subjects.ts`
- **Methods**: GET — list subjects with linked-verb/related counts; POST — create a subject (id derived inline)
- **SQL objects**: maludb_subject, maludb_subject_verb, maludb_subject_relationship, maludb_subject_with_attributes (via attach_attributes)
- **tx**: no
- **Request**: `?q`, `?limit` (default 50, max 200), `?with=attributes`; POST body `{label*, type?, description?, classifier_md?}`
- **Response**: `{subjects:[...]}`; create → `{subject:{...}}` (201)
- **Teaches**: A subject is the core SVPOR node; `subject_id`→`id`, `canonical_name`→`label`, `subject_type`→`type`, with verb links keyed by name.

### `GET PATCH DELETE` /v1/subjects/:id   → `subjects_id.ts`
- **Methods**: GET — subject detail + verbs[] + related_subjects[] + documents[]; PATCH — partial update; DELETE — remove subject
- **SQL objects**: maludb_subject, maludb_subject_verb, maludb_verb, maludb_subject_relationship; document_neighbors (graph facade)
- **tx**: yes — only the `documents` read uses `db_tx_core()` (GET, and via load in PATCH)
- **Request**: PATCH body `{label?, type?, description?, classifier_md?}`
- **Response**: `{subject:{...,verbs,related_subjects,documents}}`; DELETE → `{deleted:true,id}`
- **Teaches**: A subject detail assembles verb links (resolved by name) plus temporal relationships and graph-linked documents.

### `GET POST` /v1/subjects/:id/verbs   → `subjects_id_verbs.ts`
- **Methods**: GET — list verbs linked to subject; POST — link a verb (creates vector compartment)
- **SQL objects**: maludb_subject, maludb_subject_verb, maludb_verb, maludb_subject_verb_link (function)
- **tx**: no
- **Request**: POST body `{verb_id*}` (integer)
- **Response**: `{verbs:[...]}`; link → `{verb:{...},compartment_id}` (201); 409 if already linked
- **Teaches**: Linking a subject to a verb mints a per-pair vector compartment via `maludb_subject_verb_link`.

### `DELETE` /v1/subjects/:id/verbs/:verb_id   → `subjects_id_verbs_id.ts`
- **Methods**: DELETE — unlink a verb (removes the vector compartment)
- **SQL objects**: maludb_subject_verb_unlink (function)
- **tx**: no
- **Request**: path ids only
- **Response**: `{deleted:true,id,verb_id}`; 404 if not linked
- **Teaches**: Unlinking destroys the compartment via `maludb_subject_verb_unlink`, which returns a removed-count.

### `GET POST` /v1/subjects/:id/related-subjects   → `subjects_id_related-subjects.ts`
- **Methods**: GET — list related subjects (either endpoint); POST — create a relationship (temporal)
- **SQL objects**: maludb_subject, maludb_subject_relationship
- **tx**: no
- **Request**: POST body `{related_subject_id*, relationship_type?(='related_to'), valid_from?, valid_to?}`
- **Response**: `{related_subjects:[...]}`; create → `{related_subject:{...}}` (201); 409 duplicate
- **Teaches**: Subject↔subject relationships are bidirectional, typed, and temporally bounded (`valid_from`/`valid_to`).

### `DELETE` /v1/subjects/:id/related-subjects/:other_id   → `subjects_id_related-subjects_id.ts`
- **Methods**: DELETE — remove the relationship in either direction
- **SQL objects**: maludb_subject_relationship
- **tx**: no
- **Request**: path ids only
- **Response**: `{deleted:true,id,related_subject_id,removed}`; 404 if none
- **Teaches**: A pair-level unlink deletes the relationship regardless of which subject is `from`/`to`.

## Verbs

### `GET POST` /v1/verbs   → `verbs.ts`
- **Methods**: GET — list verbs with linked-subject count; POST — create a verb (id derived inline)
- **SQL objects**: maludb_verb, maludb_subject_verb
- **tx**: no
- **Request**: `?q`, `?limit`; POST body `{canonical_name*, type?, description?, classifier_md?}`
- **Response**: `{verbs:[...]}`; create → `{verb:{...}}` (201)
- **Teaches**: A verb is a typed predicate node; `verb_id`→`id`, `verb_type`→`type`, links counted by `verb_name`.

### `GET PATCH DELETE` /v1/verbs/:id   → `verbs_id.ts`
- **Methods**: GET — verb detail + linked subjects[]; PATCH — partial update; DELETE — remove
- **SQL objects**: maludb_verb, maludb_subject_verb, maludb_subject
- **tx**: no
- **Request**: PATCH body `{canonical_name?, type?, description?, classifier_md?}`
- **Response**: `{verb:{...,subjects}}`; DELETE → `{deleted:true,id}`
- **Teaches**: A verb's subjects are resolved by joining `maludb_subject_verb` (name-keyed) back to `maludb_subject`.

### `GET` /v1/verbs/:id/subjects   → `verbs_id_subjects.ts`
- **Methods**: GET — read-only list of subjects linked to this verb
- **SQL objects**: maludb_verb, maludb_subject_verb, maludb_subject
- **tx**: no
- **Request**: path id only
- **Response**: `{subjects:[...]}`; 404 if verb missing
- **Teaches**: The inverse of subject→verbs, traversing the same name-keyed link table.

## Types

### `GET` /v1/subject-types   → `subject-types.ts`
- **Methods**: GET — registered subject types for the dropdown (read-only)
- **SQL objects**: maludb_subject_type
- **tx**: no
- **Request**: none
- **Response**: `{subject_types:[{type,display_name,description,sort_order}]}`
- **Teaches**: `subject_type` is constrained to this registry; a DB trigger rejects unregistered values.

### `GET` /v1/verb-types   → `verb-types.ts`
- **Methods**: GET — registered verb types for the dropdown (read-only)
- **SQL objects**: maludb_verb_type
- **tx**: no
- **Request**: none
- **Response**: `{verb_types:[{type,display_name,semantic_class,description,sort_order}]}`
- **Teaches**: `verb_type` is constrained to this registry (carries a `semantic_class`); a DB trigger rejects others.

## Subject relationships

### `GET PATCH DELETE` /v1/subject-relationships/:id   → `subject-relationships_id.ts`
- **Methods**: GET — fetch one relationship row; PATCH — update type/label/validity; DELETE — remove by id
- **SQL objects**: maludb_subject_relationship (writable view)
- **tx**: no
- **Request**: PATCH body `{relationship_type?, label?, valid_from?, valid_to?}` (null clears a bound)
- **Response**: `{relationship:{...}}`; DELETE → `{deleted:true,id}`
- **Teaches**: Row-level companion to the pair unlink; the DB enforces the type FK (→422) and `valid_from<valid_to` CHECK (→422).

## Projects

### `GET POST` /v1/projects   → `projects.ts`
- **Methods**: GET — list projects; POST — create a project (subject of type 'project')
- **SQL objects**: maludb_project (view of maludb_subject WHERE subject_type='project'), maludb_subject
- **tx**: no
- **Request**: `?q`, `?limit`; POST body `{name*, description?, classifier_md?}`
- **Response**: `{projects:[...]}`; create → `{project:{...}}` (201)
- **Teaches**: A project is a specialization of subject; `maludb_project` is a filtered view, project id = subject_id.

### `GET PATCH DELETE` /v1/projects/:id   → `projects_id.ts`
- **Methods**: GET — project detail + linked subjects[]/verbs[]/documents[]; PATCH — update; DELETE — remove
- **SQL objects**: maludb_project, maludb_subject, maludb_svpor_relationship; document_neighbors (graph facade)
- **tx**: yes — only the `documents` read uses `db_tx_core()` (GET and via load in PATCH)
- **Request**: PATCH body `{name?, description?, classifier_md?}`
- **Response**: `{project:{...,subjects,verbs,documents}}`; DELETE → `{deleted:true,id}`
- **Teaches**: Project membership lives in the SVPOR graph (`source_kind='subject'` edges), separate from the subject's own verb links.

### `POST` /v1/projects/:id/archive   → `projects_id_archive.ts`
- **Methods**: POST — archive the project
- **SQL objects**: maludb_project, maludb_project_archive (function)
- **tx**: no
- **Request**: path id only
- **Response**: `{project:{...,archived_at}}`; 409 already_archived
- **Teaches**: Archival state is a timestamp (`archived_at`) toggled by the `maludb_project_archive` facade.

### `POST` /v1/projects/:id/unarchive   → `projects_id_unarchive.ts`
- **Methods**: POST — unarchive the project
- **SQL objects**: maludb_project, maludb_project_unarchive (function)
- **tx**: no
- **Request**: path id only
- **Response**: `{project:{...,archived_at}}`; 409 not_archived
- **Teaches**: The inverse facade `maludb_project_unarchive` clears `archived_at`.

### `POST PUT` /v1/projects/:id/subjects   → `projects_id_subjects.ts`
- **Methods**: POST — link one subject ('has_member' edge); PUT — replace the full member set (diff-apply)
- **SQL objects**: maludb_project, maludb_subject, maludb_svpor_relationship, maludb_svpor_relationship_create (function), maludb_svpor_relationship_delete (function)
- **tx**: yes — PUT wraps the diff in a manual transaction (not db_tx_core)
- **Request**: POST body `{subject_id*}`; PUT body `{subject_ids*:[int]}`
- **Response**: POST → `{subject:{...},edge_id}` (201), 409 dup; PUT → `{subjects:[...]}`
- **Teaches**: SVPOR `*_relationship_create` is non-idempotent and unvalidated, so the API dedupes and diffs membership itself.

### `DELETE` /v1/projects/:id/subjects/:sid   → `projects_id_subjects_id.ts`
- **Methods**: DELETE — unlink one subject ('has_member' edge)
- **SQL objects**: maludb_svpor_relationship_delete (function)
- **tx**: no
- **Request**: path ids only
- **Response**: `{deleted:true,id,subject_id}`; 404 if no link
- **Teaches**: Edge removal is a single facade call returning a removed-count.

### `POST PUT` /v1/projects/:id/verbs   → `projects_id_verbs.ts`
- **Methods**: POST — link one verb ('has_member' edge); PUT — replace the full verb set (diff-apply)
- **SQL objects**: maludb_project, maludb_verb, maludb_svpor_relationship, maludb_svpor_relationship_create (function), maludb_svpor_relationship_delete (function)
- **tx**: yes — PUT wraps the diff in a manual transaction (not db_tx_core)
- **Request**: POST body `{verb_id*}`; PUT body `{verb_ids*:[int]}`
- **Response**: POST → `{verb:{...},edge_id}` (201), 409 dup; PUT → `{verbs:[...]}`
- **Teaches**: Verbs can be graph members of a project just like subjects, using `target_kind='verb'` edges.

### `DELETE` /v1/projects/:id/verbs/:vid   → `projects_id_verbs_id.ts`
- **Methods**: DELETE — unlink one verb ('has_member' edge)
- **SQL objects**: maludb_svpor_relationship_delete (function)
- **tx**: no
- **Request**: path ids only
- **Response**: `{deleted:true,id,verb_id}`; 404 if no link
- **Teaches**: Symmetric to subject unlink, targeting `target_kind='verb'`.

## Pools

### `GET POST` /v1/pools   → `pools.ts`
- **Methods**: GET — list memory pools (excludes tombstoned); POST — create a pool
- **SQL objects**: maludb_memory_pool (direct-INSERT view)
- **tx**: no
- **Request**: `?q`, `?limit`; POST body `{name*, description?}`
- **Response**: `{pools:[...]}`; create → `{pool:{...}}` (201)
- **Teaches**: A pool is a memory container; `name`→`pool_name`, `description`→`task_objective`, with a `lifecycle_state` and sequence id.

### `GET PATCH` /v1/pools/:id   → `pools_id.ts`
- **Methods**: GET — pool detail; PATCH — update name/description (no DELETE in v1)
- **SQL objects**: maludb_memory_pool
- **tx**: no
- **Request**: PATCH body `{name?, description?}`
- **Response**: `{pool:{...}}`; 404 if missing
- **Teaches**: Pools are editable but not deletable in v1; mutation bumps `updated_at`.

### `POST` /v1/pools/:id/archive   → `pools_id_archive.ts`
- **Methods**: POST — archive the pool (sets lifecycle_state='archived' + archived_at)
- **SQL objects**: maludb_memory_pool
- **tx**: no
- **Request**: path id only
- **Response**: `{pool:{...}}`; 409 already_archived
- **Teaches**: Pool archival is an inline UPDATE on the view (no facade), gated on lifecycle_state.

## Skills

### `GET POST` /v1/skills   → `skills.ts`
- **Methods**: GET — list skills (optional visibility filter; `?subject`/`?verb` switch to tag search); POST — create a skill
- **SQL objects**: maludb_skill (direct-INSERT view), maludb_skill_search (function; 0.97.0)
- **tx**: no
- **Request**: `?visibility`, `?q`, `?subject`, `?verb`, `?limit`; POST body `{name*, description?, markdown?, version?, visibility?, packaging_kind?, enabled?}`
- **Response**: `{skills:[...]}` (tag search rows add `owner_schema, subjects, verbs, keywords, score, match_reasons, is_public, is_forkable, source_owner_schema, source_skill_id`); create → `{skill:{...}}` (201)
- **Teaches**: A skill is a versioned, visibility-scoped artifact; with `?subject`/`?verb` discovery goes through `maludb_skill_search` (tag tables + keyword/tsquery rails, public-skill folding, scoring, lineage); DB enforces `visibility∈{private,shared,public}` and `packaging_kind` sets (→422).

### `GET PATCH DELETE` /v1/skills/:id   → `skills_id.ts`
- **Methods**: GET — skill detail (incl. markdown); PATCH — update; DELETE — remove
- **SQL objects**: maludb_skill
- **tx**: no
- **Request**: PATCH body `{name?, description?, markdown?, version?, visibility?, packaging_kind?, enabled?}`
- **Response**: `{skill:{...}}`; DELETE → `{deleted:true,id}`; PATCH of `name/markdown/version/packaging_kind` on a registered agent skill (bundle_hash set) → 409 `skill_content_immutable`
- **Teaches**: The skill body lives in `markdown`; mutation bumps `updated_at` and the DB validates enum fields. Registered agent skills (0.97.0) are content-immutable — re-upload the bundle via POST /v1/skills/ingest; only description/visibility/enabled stay editable.

### `GET` /v1/skills/:id/bundle   → `skills_id_bundle.ts`
- **Methods**: GET — full agent-skill bundle for client-side reconstruction (skill pull)
- **SQL objects**: maludb_skill, maludb_skill_file, maludb_source_package
- **tx**: no
- **Request**: path id only
- **Response**: `{skill:{...,bundle_hash,frontmatter_jsonb,source_owner_schema,source_skill_id}, files:[{relative_path, file_hash, file_size, is_executable, media_type, content_base64}]}`; 404 if missing
- **Teaches**: The bundle manifest joins to content-hash-deduped `maludb_source_package` rows; base64 content + per-file hashes + executable bits let the client rebuild the directory and verify it against `bundle_hash`. Pre-bundle markdown skills pull as a synthesized one-file SKILL.md bundle.

### `POST` /v1/skills/ingest   → `skills_ingest.ts`
- **Methods**: POST — register a Claude Agent Skill bundle as an immutable skill version (maludb_core 0.97.0)
- **SQL objects**: maludb_skill, maludb_source_package, maludb_core.malu$skill_package, maludb_core.malu$skill_file, maludb_subject_type (catalog), maludb_memory_ingest_extraction (function), maludb_skill_register (function)
- **tx**: yes — one `db_tx_core()` transaction wraps graph ingest + bundle storage + registration
- **Request**: body `{name*, markdown*, frontmatter?, version?, model?, preview?, materially_different?, parent?{owner_schema, skill_id}, files?[{relative_path, content_base64|content_text, is_executable?, media_type?}]}`
- **Response**: 201 `{skill_id, version, bundle_hash, reused, model, parent:{owner_schema,skill_id,note}, materiality, register, ingest}`; identical re-push → 200 `{skill_id, version, bundle_hash, reused:true}`; preview → 200 prompt/extraction dry-run; 413 size caps (5 MB/file, 30 MB/bundle); 422 unsafe paths/invalid base64/model_not_configured; 409 model_api_key_missing; 501 ingest_unavailable (pre-0.97.0); 404 parent missing
- **Teaches**: The canonical bundle hash (sorted `"<sha256>  <path>\n"` lines) is a skill version's identity (idempotent re-push); materiality (caller override > deterministic screens > LLM judge, gray defaults material) decides supersede-vs-coexist; discovery tags come from the configured LLM (skill-extract prompt + live type catalog) or a deterministic frontmatter fallback; SKILL.md becomes an `agent_skill` document and the skill a `type='skill'` graph subject.

### `POST` /v1/skills/:id/duplicate   → `skills_id_duplicate.ts`
- **Methods**: POST — fork the skill into a new owned copy
- **SQL objects**: maludb_skill, maludb_skill_fork (function)
- **tx**: no
- **Request**: POST body `{name?, version?(='1.0.0')}`
- **Response**: `{skill:{...,source_skill_id}}` (201); 422 if source not forkable
- **Teaches**: Forking is DB-gated (`maludb_skill_fork`); only published/forkable sources copy, and the fork records its `source_skill_id`.

## Documents

### `GET POST` /v1/documents   → `documents.ts`
- **Methods**: GET — list document metadata; POST — multipart upload + graph wiring
- **SQL objects**: maludb_document, maludb_source_package, maludb_document_with_attributes (via attach_attributes); document_link_subject (graph facade)
- **tx**: yes — POST uses `db_tx_core()` for the project/subject graph links + primary_project_id
- **Request**: `?q`, `?limit`, `?with=attributes`; POST multipart parts `file*, filename, mime_type, description, document_type, projects, subjects` (last two comma-separated names)
- **Response**: `{documents:[...]}`; create → `{document:{...,primary_project_id}}` (201); 413 too large
- **Teaches**: Bytes go in `maludb_source_package.content_bytes` (bytea, bound as LOB); the document becomes a first-class graph node via `document_link_subject`.

### `GET PATCH DELETE` /v1/documents/:id   → `documents_id.ts`
- **Methods**: GET — metadata + resolved tags[]; PATCH — add/remove project & subject graph links; DELETE — remove doc, edges, and package
- **SQL objects**: maludb_document, maludb_source_package, maludb_document_tag, maludb_svpor_statement; document_link_subject, document_unlink_subject (graph facades)
- **tx**: yes — `db_tx_core()` wraps PATCH link/unlink and the DELETE edge cleanup
- **Request**: PATCH body `{link:{projects[],subjects[]}, unlink:{projects[],subjects[]}}`
- **Response**: `{document:{...,tags}}`; DELETE → `{deleted:true,id}`
- **Teaches**: Document graph edges (`subject_kind='document'` svpor_statements) must be torn down explicitly on delete since cascade only removes soft tags.

### `POST` /v1/documents-backfill   → `documents-backfill.ts`
- **Methods**: POST — backfill pre-0.87 document tags into the unified graph (idempotent)
- **SQL objects**: maludb_document_graph_backfill (function)
- **tx**: yes — `db_tx_core()`
- **Request**: none
- **Response**: `{linked:<int>}`
- **Teaches**: An onboarding/admin action that resolves legacy tags into document→subject edges + primary_project_id for the current schema.

## Document types

### `GET POST` /v1/document-types   → `document-types.ts`
- **Methods**: GET — tenant document-type picker list; POST — add a type
- **SQL objects**: maludb_document_type (writable per-schema view)
- **tx**: no
- **Request**: POST body `{document_type*, description?, display_order?}`
- **Response**: `{document_types:[...]}`; create → `{document_type:{...}}` (201); 409 on dup (23505)
- **Teaches**: An advisory picker — `maludb_document.document_type` is free text with no FK; the label is case-insensitive unique.

### `PATCH DELETE` /v1/document-types/:id   → `document-types_id.ts`
- **Methods**: PATCH — update label/description/order; DELETE — remove from picker
- **SQL objects**: maludb_document_type (writable per-schema view)
- **tx**: no
- **Request**: PATCH body `{document_type?, description?, display_order?}`
- **Response**: `{document_type:{...}}`; DELETE → `{deleted:true,id}`; 409 on collision
- **Teaches**: Deleting a type does not retag existing documents (no FK from the free-text type column).

## Notes

### `GET POST` /v1/notes   → `notes.ts`
- **Methods**: GET — list notes (memories); POST — create a note/issue
- **SQL objects**: maludb_memory, maludb_project (validation)
- **tx**: no
- **Request**: `?q`, `?type`, `?limit`; POST body `{title*, body?, type?(='note'), project_id?}`
- **Response**: `{notes:[...]}`; create → `{note:{...}}` (201)
- **Teaches**: Notes are rows in `maludb_memory`; `body`→`summary`, `type`→`memory_kind`, `project_id` stored in `payload_jsonb`.

### `GET PATCH DELETE` /v1/notes/:id   → `notes_id.ts`
- **Methods**: GET — note detail; PATCH — update fields/project link; DELETE — remove
- **SQL objects**: maludb_memory, maludb_project (validation)
- **tx**: no
- **Request**: PATCH body `{title?, body?, type?, project_id?}` (null clears project via jsonb minus)
- **Response**: `{note:{...}}`; DELETE → `{deleted:true,id}`
- **Teaches**: The project link is maintained inside `payload_jsonb` using `jsonb_set` / `- 'project_id'`.

### `POST` /v1/notes/:id/close-issue   → `notes_id_close-issue.ts`
- **Methods**: POST — close an issue-type note (sets issue_closed_at=now())
- **SQL objects**: maludb_memory
- **tx**: no
- **Request**: path id only
- **Response**: `{note:{...,issue_closed_at}}`; 409 if not an issue or already closed
- **Teaches**: Only `memory_kind='issue'` notes carry a closable lifecycle via `issue_closed_at`.

### `POST` /v1/notes/:id/reopen-issue   → `notes_id_reopen-issue.ts`
- **Methods**: POST — reopen a closed issue (clears issue_closed_at)
- **SQL objects**: maludb_memory
- **tx**: no
- **Request**: path id only
- **Response**: `{note:{...,issue_closed_at}}`; 409 if not an issue or not closed
- **Teaches**: The inverse transition nulls `issue_closed_at`.

## Episodes

### `GET POST` /v1/episodes   → `episodes.ts`
- **Methods**: GET — list episodes (newest first); POST — register an episode (auto-mints backing subject)
- **SQL objects**: maludb_episode (writable view), maludb_register_episode (facade), maludb_episode_with_attributes (via attach_attributes)
- **tx**: yes — `db_tx_core()` wraps both the GET list and the POST register
- **Request**: `?q`, `?kind`, `?provenance`, `?limit`, `?with=attributes`; POST body `{title*, kind?(='activity'), summary?, payload?, occurred_at?, occurred_until?, sensitivity?(='internal'), provenance?(='provided')}`
- **Response**: `{episodes:[...]}`; create → `{episode:{...,subject_id,canonical_name}}` (201)
- **Teaches**: An episode (event) is folded onto a subject; `maludb_register_episode` auto-mints that subject with a dated canonical_name. DB enforces sensitivity/provenance sets (→422).

### `GET PATCH DELETE` /v1/episodes/:id   → `episodes_id.ts`
- **Methods**: GET — assembled event via facade; PATCH — update episode fields; DELETE — remove
- **SQL objects**: maludb_episode, maludb_episode_get (function)
- **tx**: yes — `db_tx_core()` wraps GET, PATCH, and DELETE
- **Request**: PATCH body `{title?, summary?, kind?, payload?, occurred_at?, occurred_until?, sensitivity?, provenance?, lifecycle_state?}`
- **Response**: `{episode,subject,statements[],details[]}` (the raw facade JSON, not key-wrapped); DELETE → `{deleted:true,id}`
- **Teaches**: `maludb_episode_get` returns the whole event graph (subject + every SVO statement touching it) as resolved jsonb; PATCH provenance is the accept/reject transition.

### `GET POST` /v1/episodes/:id/statements   → `episodes_id_statements.ts`
- **Methods**: GET — statements whose object is this episode; POST — add a link to the event
- **SQL objects**: maludb_episode, maludb_svpor_statement; svpor_statement_cols/shape_statement/svpor_create_statement (helpers)
- **tx**: yes — `db_tx_core()` wraps GET and POST
- **Request**: POST body same as /v1/statements but object defaults to `{episode_object, id}`
- **Response**: `{statements:[...]}`; create → `{statement:{...}}` (201); 404 if episode missing
- **Teaches**: Event participation (attendees, attached docs, decisions) is modeled as SVO statements with `object_kind='episode_object'`.

## Episode types

### `GET POST` /v1/episode-types   → `episode-types.ts`
- **Methods**: GET — tenant episode-type picker list; POST — add a type
- **SQL objects**: maludb_episode_type (writable per-schema view)
- **tx**: no
- **Request**: POST body `{episode_type*, description?, display_order?}`
- **Response**: `{episode_types:[...]}`; create → `{episode_type:{...}}` (201); 409 on dup
- **Teaches**: Advisory only — `episode_kind` is free text (no FK); ships empty, and a kind doubles as the backing subject's type.

### `PATCH DELETE` /v1/episode-types/:id   → `episode-types_id.ts`
- **Methods**: PATCH — update; DELETE — remove from picker
- **SQL objects**: maludb_episode_type (writable per-schema view)
- **tx**: no
- **Request**: PATCH body `{episode_type?, description?, display_order?}`
- **Response**: `{episode_type:{...}}`; DELETE → `{deleted:true,id}`; 409 on collision
- **Teaches**: Deleting a type does not retag episodes (free-text kind, no FK).

## Statements

### `GET POST` /v1/statements   → `statements.ts`
- **Methods**: GET — list/filter SVO statements (review queue via provenance); POST — create a statement
- **SQL objects**: maludb_svpor_statement; svpor_statement_cols/shape_statement/svpor_create_statement (helpers, which call facades like maludb_svpor_statement_create / register_svpor_subject)
- **tx**: yes — `db_tx_core()` wraps GET and POST
- **Request**: `?provenance`, `?object_kind`, `?object_id`, `?subject_kind`, `?subject_id`, `?verb_id`, `?limit`; POST body resolves verb/subject by name+kind
- **Response**: `{statements:[...]}`; create → `{statement:{...}}` (201)
- **Teaches**: A statement is `(subject_kind,subject_id) --verb_id--> (object_kind,object_id)`, idempotent on those five fields; `?provenance=suggested` is the review queue.

### `GET PATCH DELETE` /v1/statements/:id   → `statements_id.ts`
- **Methods**: GET — statement row; PATCH — set provenance and/or close validity; DELETE — remove
- **SQL objects**: maludb_svpor_statement, maludb_svpor_statement_set_provenance, maludb_svpor_statement_close, maludb_svpor_statement_delete (functions)
- **tx**: yes — `db_tx_core()` wraps GET, PATCH, DELETE
- **Request**: PATCH body `{provenance?}` (accept/reject) and/or `{valid_to?}` or `{close:true}`
- **Response**: `{statement:{...}}`; DELETE → `{deleted:true,id}`
- **Teaches**: Statement lifecycle is facade-driven: provenance transitions (suggested→accepted/rejected) and temporal closing via `*_close`.

## Attributes

### `GET POST` /v1/attributes   → `attributes.ts`
- **Methods**: GET — list/filter typed attributes (review queue via provenance); POST — upsert an attribute
- **SQL objects**: maludb_svpor_attribute; svpor_attribute_cols/shape_attribute/svpor_create_attribute (helpers → maludb_svpor_attribute_create facade)
- **tx**: yes — `db_tx_core()` wraps GET and POST
- **Request**: `?target_kind`, `?target_id`, `?attr_name`, `?provenance`, `?limit`; POST body upsert keyed on target_kind+target_id+attr_name
- **Response**: `{attributes:[...]}`; create → `{attribute:{...}}` (201)
- **Teaches**: An attribute is a typed property of any node OR an edge (`target_kind='svpor_statement'`), idempotent on its key triple.

### `GET PATCH DELETE` /v1/attributes/:id   → `attributes_id.ts`
- **Methods**: GET — attribute row; PATCH — provenance review transition only; DELETE — remove
- **SQL objects**: maludb_svpor_attribute, maludb_svpor_attribute_set_provenance, maludb_svpor_attribute_delete (functions; create facade referenced in docstring)
- **tx**: yes — `db_tx_core()` wraps GET, PATCH, DELETE
- **Request**: PATCH body `{provenance*}` (value changes must re-upsert via POST /v1/attributes)
- **Response**: `{attribute:{...}}`; DELETE → `{deleted:true,id}`
- **Teaches**: In-place PATCH only accepts the provenance accept/reject transition; any value edit is an upsert.

## Attribute templates

### `GET POST` /v1/attribute-templates   → `attribute-templates.ts`
- **Methods**: GET — typed-property form catalog; POST — create a template entry
- **SQL objects**: maludb_attribute_template (writable view), maludb_attribute_template_create (function)
- **tx**: yes — `db_tx_core()` wraps GET and POST
- **Request**: `?applies_to`, `?type_value`, `?limit` (default 200, max 500); POST body `{applies_to*, type_value*, attr_name*, value_type*, requirement?(='optional'), label?, description?, unit?, allowed_values?, default_value?, display_order?}`
- **Response**: `{attribute_templates:[...]}`; create → `{attribute_template:{...}}` (201)
- **Teaches**: Templates drive forms — they declare which typed attributes apply to a node/edge type; DB enforces `applies_to`/`value_type`/`requirement` enums (→422). No PATCH (recreate to change).

### `GET DELETE` /v1/attribute-templates/:id   → `attribute-templates_id.ts`
- **Methods**: GET — one template row; DELETE — remove template
- **SQL objects**: maludb_attribute_template (writable view), maludb_attribute_template_delete (function)
- **tx**: yes — `db_tx_core()` wraps GET and DELETE
- **Request**: path id only
- **Response**: `{attribute_template:{...}}`; DELETE → `{deleted:true,id}`
- **Teaches**: The 0.83 surface is create+delete only; no in-place template edits.

### `GET` /v1/attribute-check   → `attribute-check.ts`
- **Methods**: GET — advisory completeness check for a target
- **SQL objects**: maludb_attribute_check (function)
- **tx**: yes — `db_tx_core()`
- **Request**: `?target_kind*`, `?target_id*` (both required)
- **Response**: `{check:{applies_to,type_value,missing_required[],fields[]}}`
- **Teaches**: A read-only advisory layer — the DB never rejects on missing attributes; the form layer validates completeness itself.

## Objects / handles

### `POST` /v1/objects/:kind   → `objects.ts`
- **Methods**: POST — atomically create an object + apply its typed attributes
- **SQL objects**: register_svpor_subject, maludb_register_episode, maludb_attributes_apply, maludb_object_get (functions)
- **tx**: yes — `db_tx_core()` wraps register → attributes_apply → object_get
- **Request**: path `{kind}` (∈ subject, episode_object); body = object fields + optional `attributes:[]` array
- **Response**: `{object:{...}}` (201, the assembled handle)
- **Teaches**: The `(object_kind,object_id)` handle is the canonical resource; create+attributes land atomically in one transaction or neither does.

### `GET` /v1/objects/:kind/:id   → `objects_id.ts`
- **Methods**: GET — resolve one handle with its attributes (and statements/details for episodes)
- **SQL objects**: maludb_object_get (function)
- **tx**: yes — `db_tx_core()`
- **Request**: path `{kind}`, `{id}`
- **Response**: `{object:{kind,id,object,attributes,[statements,details]}}`; 404 if unknown handle
- **Teaches**: A single `maludb_object_get` read assembles the full object-with-attributes handle across the graph/attribute surface.

## Edges

### `GET` /v1/edges   → `edges.ts`
- **Methods**: GET — list rows from the unified edge view (read-only)
- **SQL objects**: maludb_edge (view; SVO statements + lineage unified)
- **tx**: yes — `db_tx_core()`
- **Request**: `?source_kind`, `?source_id`, `?target_kind`, `?target_id`, `?rel`, `?edge_store`, `?limit` (default 100, max 500)
- **Response**: `{edges:[{edge_store,edge_id,source_kind,source_id,rel,target_kind,target_id,confidence,provenance}]}`
- **Teaches**: `maludb_edge` is the single read surface unifying SVO statement edges and lineage edges, tagged by `edge_store`.

## Graph

### `GET` /v1/graph/neighbors   → `graph_neighbors.ts`
- **Methods**: GET — one labeled hop out of a handle
- **SQL objects**: maludb_graph_neighbors (table function)
- **tx**: yes — `db_tx_core()`
- **Request**: `?kind*`, `?id*`, `?direction=both` (both|out|in), `?rel` (comma-separated filter)
- **Response**: `{kind,id,direction,neighbors:[{neighbor_kind,neighbor_id,rel,edge_store,confidence,provenance,label}]}`
- **Teaches**: One-hop traversal over the unified edge view with direction and rel filtering.

### `GET` /v1/graph/walk   → `graph_walk.ts`
- **Methods**: GET — cycle-safe multi-hop BFS from a handle
- **SQL objects**: maludb_graph_walk (table function)
- **tx**: yes — `db_tx_core()`
- **Request**: `?kind*`, `?id*`, `?max_depth=4` (max 20), `?direction=both`, `?rel`
- **Response**: `{kind,id,max_depth,direction,walk:[{object_kind,object_id,depth,rel,edge_store,label,path[]}]}`
- **Teaches**: Breadth-first traversal returns each reached object with its depth and the path of object ids walked; Postgres text[] path is parsed to an int array.

## Memory

### `GET PUT POST` /v1/memory/config   → `memory_config.ts`
- **Methods**: GET — read model/embedding/prompt config; PUT/POST — configure provider+alias+prompt+embedding+defaults
- **SQL objects**: maludb_memory_model_config, maludb_core.secret_set, maludb_register_model_provider, maludb_register_model_alias, maludb_memory_set_model_config (functions)
- **tx**: yes — `db_tx_core()` wraps the whole secret_set→register→bind→read-back sequence (PUT/POST); GET also wraps the read
- **Request**: `?namespace=default` (GET); body `{namespace, secret_name, token?, provider:{name,kind,adapter_name?,data_sensitivity?}, alias:{name,model_identifier,context_length?,base_url}, prompt_template?, embedding_model, generation_params?, default_subject_type?, default_provenance?}`
- **Response**: `{namespace,config}` (200); `secret_ref` is the name never the token
- **Teaches**: Per-tenant self-service model setup — the token is stored encrypted via `secret_set` and referenced by name, never inlined into rows or logs.

### `POST` /v1/memory/documents   → `memory_documents.ts`
- **Methods**: POST — upload a doc, extract SVPO edges, embed, and ingest into the vector store
- **SQL objects**: maludb_memory_model_config, maludb_upload_document, maludb_memory_ingest_edge (functions); maludb_core.malu_vector (type cast)
- **tx**: yes — `db_tx_core()` for the config read, and a separate `db_tx_core()` wrapping upload_document + per-edge ingest
- **Request**: body `{title*, text*, source_type?, media_type?, document_type?, projects?[], subjects?[], verbs?[], events?[], metadata?, namespace?, embedding_model?, chunk?:{max,overlap}, edges?[]}`
- **Response**: `{document_id,namespace,embedding_model,extractor,chunk_count,edges:[...]}` (201); 422 no_edges
- **Teaches**: The API is the model worker — it chunks/extracts/embeds in code, then writes atomically per document via the ingest facades; extraction defaults to provenance='suggested'.

### `POST` /v1/memory/ingest   → `memory_ingest.ts`
- **Methods**: POST — text → LLM extraction → ingest the extraction JSON verbatim
- **SQL objects**: maludb_subject, maludb_verb, maludb_subject_type, maludb_core.malu$svpor_subject_type (fallback), pg_proc (facade presence check), maludb_upload_document, maludb_memory_ingest_extraction (functions)
- **tx**: yes — `db_tx_core()` wraps upload_document + ingest_extraction (the KNOWN_SUBJECTS/VERBS/type-catalog reads run outside a tx)
- **Request**: body `{text*, model?(='chatgpt-4o'), hints?[], namespace?, preview?}`; `preview=true` returns assembled prompts without calling the model
- **Response**: preview → `{model,api_format,system_prompt,user_message,counts}`; live → `{document_id,model,api_format,namespace,result}` (201)
- **Teaches**: Builds the GPT-4o/Anthropic extraction prompt from stored local `model_prompts` + live KNOWN_SUBJECTS/KNOWN_VERBS + subject-type catalog, then passes model JSON verbatim to `maludb_memory_ingest_extraction` (requires core 0.92.0).

### `POST` /v1/memory/search   → `memory_search.ts`
- **Methods**: POST — embed the query and ANN-search the graph-bound vector store
- **SQL objects**: maludb_memory_model_config, maludb_memory_search (function); maludb_core.malu_vector (type cast)
- **tx**: yes — `db_tx_core()` for the config read and a separate one for the search
- **Request**: body `{query*, subject?, verb?, namespace?, limit?(=20,max 200), metric?(='cosine')}` — at least one of subject/verb required (compartment pre-filter)
- **Response**: `{namespace,embedding_model,results:[{chunk_id,statement_id,document_id,source_text,distance,similarity,rank_no,subject_name,verb_name}]}`
- **Teaches**: Search must embed with the SAME model/dimension used at ingest, and pre-filters to a (subject,verb) compartment before the ANN scan.

## Model prompts

### `GET POST` /v1/model-prompts   → `model-prompts.ts`
- **Methods**: GET — list configured model prompts (key masked); POST — upsert a model prompt + LLM connection
- **SQL objects**: none (operates on the local SQLite `model_prompts` table; authorizes by test-connecting to Postgres)
- **tx**: no (local upsert)
- **Request**: body `{pg_dbname*, pg_user*, pg_password*, model_name, api_format('openai'|'anthropic'), system_prompt, base_url, api_key?, max_tokens?}` (authorization via the PG triple, also required on GET)
- **Response**: GET → `{model_prompts:[...]}`; POST → `{model_prompt:{...,api_key_set}}` (200)
- **Teaches**: Per-model extraction prompts and LLM creds live in the local store, never Postgres; the API key is write-only (returned only as `api_key_set`). Does NOT use `requireAuth()`.

## Tokens

### `GET POST` /v1/tokens   → `tokens.ts`
- **Methods**: GET — list tokens for a PG connection (metadata only); POST — mint a new API token
- **SQL objects**: none (local SQLite `users` table; authorizes via `testCredentials` connecting to Postgres)
- **tx**: no
- **Request**: body `{pg_dbname*, pg_user*, pg_password*}` + POST `{role?(='executor'), user_id?, expires_in_days?, device_name?}`
- **Response**: GET → `{tokens:[...]}`; POST → `{token,id,user_id,role,pg_dbname,pg_user,expires_at,device_name}` (201)
- **Teaches**: Authorization is the Postgres login itself; the plaintext token is shown once and only its sha256 hash is stored. Does NOT use `requireAuth()`.

### `DELETE` /v1/tokens/:id   → `tokens_id.ts`
- **Methods**: DELETE — revoke (delete) a token row
- **SQL objects**: none (local SQLite `users` table; authorizes via `testCredentials`)
- **tx**: no
- **Request**: body `{pg_dbname*, pg_user*, pg_password*}`; token must belong to that PG connection
- **Response**: `{deleted:true,id}`; 403 forbidden if token belongs to another connection, 404 if missing
- **Teaches**: You can only revoke tokens for a Postgres connection whose password you can prove. Does NOT use `requireAuth()`.

## Health (TS-only)

### `GET` /v1/health   → `health.ts`
- **Methods**: GET — unauthenticated liveness probe
- **SQL objects**: none
- **tx**: no
- **Request**: none
- **Response**: `{status:'ok', name, version, time}`
- **Teaches**: The one endpoint with no auth and no SQL — the entry point of the learning path.
