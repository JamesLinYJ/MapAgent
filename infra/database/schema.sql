-- +-------------------------------------------------------------------------
--
--   地理智能平台 - 权威 PostGIS 数据库基线
--
--   文件:       schema.sql
--
--   日期:       2026年08月23日
--   作者:       JamesLinYJ
--   协助:       OpenAI Codex:GPT-5.6 Sol
--
--   用途:       仅用于空数据库的首次初始化。
--               本文件是数据库结构的唯一 SQL 事实源；不执行增量迁移、
--               不回填旧结构，也不在应用启动时修改已有表。
-- --------------------------------------------------------------------------

BEGIN;

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: postgis; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;


--
-- Name: EXTENSION postgis; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION postgis IS 'PostGIS geometry and geography spatial types and functions';


--
-- Name: geo_agent_platform_layer_tiles(integer, integer, integer, json); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.geo_agent_platform_layer_tiles(z integer, x integer, y integer, query json) RETURNS bytea
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  WITH tile_bounds AS (
    SELECT ST_TileEnvelope(z, x, y) AS geometry
  ), query_bounds AS (
    SELECT ST_Transform(
      ST_TileEnvelope(z, x, y, margin => (64.0 / 4096)),
      4326
    ) AS geometry
  ), tile_features AS (
    SELECT
      feature.feature_id,
      feature.properties_json,
      ST_AsMVTGeom(
        ST_Transform(feature.geometry, 3857),
        tile_bounds.geometry,
        4096,
        64,
        true
      ) AS geometry
    FROM platform_layer_features AS feature
    CROSS JOIN tile_bounds
    CROSS JOIN query_bounds
    WHERE feature.map_layer_id = query->>'mapLayerId'
      AND feature.geometry && query_bounds.geometry
  )
  -- ST_AsMVT 的第五个参数只接受整数列作为 MVT feature id。地理智能平台 的
  -- feature_id 是跨导入稳定的文本标识，因此保留为普通 MVT 属性；MapLibre
  -- 查询结果仍可读取它，同时不会让 PostGIS 因错误的整数主键契约而拒绝出瓦片。
  SELECT ST_AsMVT(tile_features, 'features', 4096, 'geometry')
  FROM tile_features;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: auth_account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_account (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_session (
    id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address text,
    user_agent text,
    impersonated_by text,
    user_id text NOT NULL
);


--
-- Name: auth_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_user (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    role text DEFAULT 'user'::text NOT NULL,
    banned boolean DEFAULT false NOT NULL,
    ban_reason text,
    ban_expires timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_agent_step_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_agent_step_contexts (
    step_id text NOT NULL,
    run_id text NOT NULL,
    turn_id text NOT NULL,
    segment_id text NOT NULL,
    model_request_index integer NOT NULL,
    objective_revision integer NOT NULL,
    input_cursor integer NOT NULL,
    world_revision integer NOT NULL,
    runtime_config_digest text NOT NULL,
    tool_plan_digest text NOT NULL,
    context_digest text NOT NULL,
    context_json jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT platform_agent_step_contexts_input_cursor_check CHECK ((input_cursor >= 0)),
    CONSTRAINT platform_agent_step_contexts_model_request_index_check CHECK ((model_request_index > 0)),
    CONSTRAINT platform_agent_step_contexts_objective_revision_check CHECK ((objective_revision > 0)),
    CONSTRAINT platform_agent_step_contexts_world_revision_check CHECK ((world_revision > 0))
);


--
-- Name: platform_context_windows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_context_windows (
    context_window_id text NOT NULL,
    run_id text NOT NULL,
    generation integer NOT NULL,
    schema_version integer NOT NULL,
    prompt_protocol_version text NOT NULL,
    source_digest text NOT NULL,
    source_summary_json jsonb NOT NULL,
    compaction_json jsonb,
    started_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT platform_context_windows_generation_check CHECK ((generation > 0)),
    CONSTRAINT platform_context_windows_schema_version_check CHECK ((schema_version > 0))
);


--
-- Name: platform_model_request_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_model_request_records (
    request_id text NOT NULL,
    schema_version integer NOT NULL,
    run_id text NOT NULL,
    turn_id text NOT NULL,
    step_id text NOT NULL,
    segment_id text NOT NULL,
    objective_revision integer NOT NULL,
    input_cursor integer NOT NULL,
    context_window_id text NOT NULL,
    context_digest text NOT NULL,
    agent_step_context_schema_version integer NOT NULL,
    provider text NOT NULL,
    model_id text NOT NULL,
    input_object_hash text NOT NULL,
    input_digest text NOT NULL,
    instructions_digest text NOT NULL,
    tool_plan_digest text NOT NULL,
    world_revision integer NOT NULL,
    input_entry_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    summary_object_hashes jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT platform_model_request_records_input_cursor_check CHECK ((input_cursor >= 0)),
    CONSTRAINT platform_model_request_records_objective_revision_check CHECK ((objective_revision > 0)),
    CONSTRAINT platform_model_request_records_schema_version_check CHECK ((schema_version > 0)),
    CONSTRAINT platform_model_request_records_step_context_schema_version_check CHECK ((agent_step_context_schema_version > 0)),
    CONSTRAINT platform_model_request_records_world_revision_check CHECK ((world_revision > 0))
);


--
-- Name: platform_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_artifacts (
    artifact_id text NOT NULL,
    run_id text NOT NULL,
    workspace_id text,
    created_by_user_id text,
    visibility text DEFAULT 'workspace'::text NOT NULL,
    artifact_type text NOT NULL,
    name text NOT NULL,
    uri text NOT NULL,
    display_json jsonb NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    content_relative_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_audit_events (
    audit_event_id text NOT NULL,
    actor_user_id text,
    workspace_id text,
    action text NOT NULL,
    object_type text NOT NULL,
    object_id text,
    outcome text DEFAULT 'allowed'::text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_automation_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_automation_definitions (
    automation_id text NOT NULL,
    workspace_id text,
    created_by_user_id text,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    version text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    published_revision integer,
    source text DEFAULT 'builtin'::text NOT NULL,
    lifecycle text DEFAULT 'published'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    parameters_schema_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    default_parameters_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    required_tools_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    requires_approval boolean DEFAULT false NOT NULL,
    timeout_seconds integer DEFAULT 900 NOT NULL,
    output_type text DEFAULT 'conversation'::text NOT NULL,
    definition_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_automation_definitions_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['draft'::text, 'published'::text, 'disabled'::text]))),
    CONSTRAINT platform_automation_definitions_ownership_check CHECK ((((source = 'builtin'::text) AND (workspace_id IS NULL)) OR ((source = 'workspace'::text) AND (workspace_id IS NOT NULL)))),
    CONSTRAINT platform_automation_definitions_revision_check CHECK ((revision > 0)),
    CONSTRAINT platform_automation_definitions_source_check CHECK ((source = ANY (ARRAY['builtin'::text, 'workspace'::text]))),
    CONSTRAINT platform_automation_definitions_timeout_check CHECK ((timeout_seconds > 0))
);


--
-- Name: platform_automation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_automation_runs (
    automation_run_id text NOT NULL,
    automation_id text NOT NULL,
    automation_revision integer NOT NULL,
    scheduled_task_id text,
    workspace_id text NOT NULL,
    created_by_user_id text NOT NULL,
    run_id text,
    status text DEFAULT 'queued'::text NOT NULL,
    current_step text,
    trigger_kind text DEFAULT 'manual'::text NOT NULL,
    error_message text,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    node_runs_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    pending_approval_json jsonb,
    outputs_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT platform_automation_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'waiting_approval'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT platform_automation_runs_trigger_kind_check CHECK ((trigger_kind = ANY (ARRAY['manual'::text, 'schedule'::text, 'agent'::text])))
);


--
-- Name: platform_automation_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_automation_versions (
    automation_id text NOT NULL,
    revision integer NOT NULL,
    lifecycle text NOT NULL,
    definition_json jsonb NOT NULL,
    created_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT platform_automation_versions_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text]))),
    CONSTRAINT platform_automation_versions_revision_check CHECK ((revision > 0))
);


--
-- Name: platform_conversation_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_conversation_entries (
    entry_id text NOT NULL,
    session_id text NOT NULL,
    thread_id text NOT NULL,
    run_id text,
    turn_id text,
    sequence integer NOT NULL,
    parent_entry_id text,
    logical_parent_entry_id text,
    kind text NOT NULL,
    payload_json jsonb NOT NULL,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_conversation_entries_sequence_check CHECK ((sequence > 0))
);


--
-- Name: platform_event_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_event_outbox (
    outbox_id text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    event_type text NOT NULL,
    payload_json jsonb NOT NULL,
    trace_id text,
    attempt_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone
);


--
-- Name: platform_file_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_file_objects (
    file_id text NOT NULL,
    workspace_id text,
    session_id text NOT NULL,
    thread_id text NOT NULL,
    created_by_user_id text,
    name text NOT NULL,
    source_key text NOT NULL,
    source_relative_path text,
    relative_path text NOT NULL,
    content_hash text NOT NULL,
    size_bytes integer NOT NULL,
    media_type text NOT NULL,
    request_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ready_at timestamp with time zone,
    deleted_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_file_objects_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT platform_file_objects_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'deleted'::text])))
);


--
-- Name: platform_geo_world_diffs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_geo_world_diffs (
    diff_id text NOT NULL,
    run_id text NOT NULL,
    from_revision integer NOT NULL,
    to_revision integer NOT NULL,
    diff_json jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT platform_geo_world_diffs_from_revision_check CHECK ((from_revision > 0)),
    CONSTRAINT platform_geo_world_diffs_revision_step_check CHECK ((to_revision = (from_revision + 1)))
);


--
-- Name: platform_geo_world_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_geo_world_snapshots (
    run_id text NOT NULL,
    workspace_id text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    state_schema_version integer NOT NULL,
    state_digest text NOT NULL,
    state_json jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_geo_world_snapshots_revision_check CHECK ((revision > 0)),
    CONSTRAINT platform_geo_world_snapshots_state_schema_version_check CHECK ((state_schema_version > 0))
);


--
-- Name: platform_layer_features; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_layer_features (
    map_layer_id text NOT NULL,
    feature_id text NOT NULL,
    properties_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    geometry public.geometry(Geometry,4326) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_map_layers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_map_layers (
    map_layer_id text NOT NULL,
    ownership_scope text NOT NULL,
    workspace_id text,
    thread_id text,
    artifact_id text,
    managed_layer_key text,
    title text NOT NULL,
    replacement_group text,
    source_type text DEFAULT 'artifact'::text NOT NULL,
    geometry_type text DEFAULT 'unknown'::text NOT NULL,
    srid integer DEFAULT 4326 NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    feature_count integer,
    property_schema_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    category text DEFAULT 'general'::text NOT NULL,
    tags_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    analysis_capabilities_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_config_summary text,
    session_id text,
    created_by_user_id text,
    visibility text DEFAULT 'workspace'::text NOT NULL,
    readonly boolean DEFAULT false NOT NULL,
    status text DEFAULT 'ready'::text NOT NULL,
    error_message text,
    bounds_json jsonb NOT NULL,
    crs text NOT NULL,
    min_zoom integer DEFAULT 0 NOT NULL,
    max_zoom integer DEFAULT 22 NOT NULL,
    source_json jsonb NOT NULL,
    style_json jsonb NOT NULL,
    legend_json jsonb,
    temporal_json jsonb,
    capabilities_json jsonb NOT NULL,
    data_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_platform_map_layers_failure CHECK (((status <> 'failed'::text) OR (error_message IS NOT NULL))),
    CONSTRAINT chk_platform_map_layers_owner CHECK (((artifact_id IS NULL) <> (managed_layer_key IS NULL))),
    CONSTRAINT chk_platform_map_layers_scope CHECK ((((ownership_scope = 'system'::text) AND (workspace_id IS NULL) AND (thread_id IS NULL)) OR ((ownership_scope = 'workspace'::text) AND (workspace_id IS NOT NULL) AND (thread_id IS NULL)) OR ((ownership_scope = 'thread'::text) AND (workspace_id IS NOT NULL) AND (thread_id IS NOT NULL)))),
    CONSTRAINT platform_map_layers_check CHECK ((((max_zoom >= 0) AND (max_zoom <= 24)) AND (max_zoom >= min_zoom))),
    CONSTRAINT platform_map_layers_data_version_check CHECK ((data_version > 0)),
    CONSTRAINT platform_map_layers_feature_count_check CHECK (((feature_count IS NULL) OR (feature_count >= 0))),
    CONSTRAINT platform_map_layers_min_zoom_check CHECK (((min_zoom >= 0) AND (min_zoom <= 24))),
    CONSTRAINT platform_map_layers_ownership_scope_check CHECK ((ownership_scope = ANY (ARRAY['system'::text, 'workspace'::text, 'thread'::text]))),
    CONSTRAINT platform_map_layers_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'ready'::text, 'failed'::text, 'disabled'::text]))),
    CONSTRAINT platform_map_layers_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'workspace'::text, 'public'::text])))
);


--
-- Name: platform_map_scene_layers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_map_scene_layers (
    scene_id text NOT NULL,
    map_layer_id text NOT NULL,
    layer_order integer NOT NULL,
    visible boolean DEFAULT true NOT NULL,
    opacity_percent integer DEFAULT 100 NOT NULL,
    style_override_json jsonb,
    label_json jsonb,
    current_frame_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_map_scene_layers_layer_order_check CHECK ((layer_order >= 0)),
    CONSTRAINT platform_map_scene_layers_opacity_percent_check CHECK (((opacity_percent >= 0) AND (opacity_percent <= 100)))
);


--
-- Name: platform_map_scenes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_map_scenes (
    scene_id text NOT NULL,
    workspace_id text NOT NULL,
    thread_id text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    default_layers_initialized boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_map_scenes_version_check CHECK ((version > 0))
);


--
-- Name: platform_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_memberships (
    membership_id text NOT NULL,
    workspace_id text NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_meteorological_datasets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_meteorological_datasets (
    dataset_id text NOT NULL,
    workspace_id text,
    created_by_user_id text,
    visibility text DEFAULT 'workspace'::text NOT NULL,
    session_id text NOT NULL,
    thread_id text,
    filename text NOT NULL,
    original_filename text NOT NULL,
    file_id text,
    file_relative_path text NOT NULL,
    size_bytes integer DEFAULT 0 NOT NULL,
    content_hash text,
    media_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    status text DEFAULT 'ready'::text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_meteorological_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_meteorological_jobs (
    job_id text NOT NULL,
    dataset_id text NOT NULL,
    workspace_id text,
    created_by_user_id text,
    session_id text NOT NULL,
    thread_id text,
    kind text NOT NULL,
    status text NOT NULL,
    message text,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: platform_model_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_model_providers (
    provider_id text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    display_name text NOT NULL,
    base_url text NOT NULL,
    protocol text NOT NULL,
    models_json jsonb NOT NULL,
    default_model text NOT NULL,
    tool_schema_mode text NOT NULL,
    api_key text,
    created_by_user_id text NOT NULL,
    last_validated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_model_providers_models_array_check CHECK (((jsonb_typeof(models_json) = 'array'::text) AND (jsonb_array_length(models_json) > 0))),
    CONSTRAINT platform_model_providers_protocol_check CHECK ((protocol = ANY (ARRAY['responses'::text, 'chat_completions'::text]))),
    CONSTRAINT platform_model_providers_revision_check CHECK ((revision > 0)),
    CONSTRAINT platform_model_providers_tool_schema_mode_check CHECK ((tool_schema_mode = ANY (ARRAY['strict'::text, 'compatible'::text])))
);


--
-- Name: platform_model_result_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_model_result_cache (
    cache_key text NOT NULL,
    workspace_id text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    purpose text NOT NULL,
    content text NOT NULL,
    usage_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    hit_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_accessed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_model_result_cache_hit_count_check CHECK ((hit_count >= 0))
);


--
-- Name: platform_rbac_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_rbac_policies (
    policy_id text NOT NULL,
    ptype text NOT NULL,
    v0 text DEFAULT ''::text NOT NULL,
    v1 text DEFAULT ''::text NOT NULL,
    v2 text DEFAULT ''::text NOT NULL,
    v3 text DEFAULT ''::text NOT NULL,
    v4 text DEFAULT ''::text NOT NULL,
    v5 text DEFAULT ''::text NOT NULL
);


--
-- Name: platform_run_domain_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_run_domain_events (
    event_id text NOT NULL,
    run_id text NOT NULL,
    sequence integer NOT NULL,
    event_type text NOT NULL,
    schema_version integer NOT NULL,
    objective_revision integer NOT NULL,
    turn_id text,
    step_id text,
    causation_id text,
    correlation_id text NOT NULL,
    actor_kind text NOT NULL,
    actor_id text,
    payload_json jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    CONSTRAINT platform_run_domain_events_objective_revision_check CHECK ((objective_revision > 0)),
    CONSTRAINT platform_run_domain_events_schema_version_check CHECK ((schema_version > 0)),
    CONSTRAINT platform_run_domain_events_sequence_check CHECK ((sequence > 0))
);


--
-- Name: platform_run_inputs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_run_inputs (
    input_id text NOT NULL,
    run_id text NOT NULL,
    thread_id text NOT NULL,
    turn_id text NOT NULL,
    entry_id text NOT NULL,
    item_id text NOT NULL,
    kind text DEFAULT 'steering'::text NOT NULL,
    content text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    input_sequence integer NOT NULL,
    lease_id text,
    leased_at timestamp with time zone,
    model_request_id text,
    included_at timestamp with time zone,
    checkpointed_at timestamp with time zone,
    CONSTRAINT platform_run_inputs_content_check CHECK ((length(btrim(content)) > 0)),
    CONSTRAINT platform_run_inputs_delivery_state_check CHECK ((((status = 'queued'::text) AND (lease_id IS NULL) AND (leased_at IS NULL) AND (model_request_id IS NULL) AND (included_at IS NULL) AND (checkpointed_at IS NULL)) OR ((status = 'leased'::text) AND (lease_id IS NOT NULL) AND (leased_at IS NOT NULL) AND (model_request_id IS NULL) AND (included_at IS NULL) AND (checkpointed_at IS NULL)) OR ((status = 'included'::text) AND (lease_id IS NOT NULL) AND (leased_at IS NOT NULL) AND (model_request_id IS NOT NULL) AND (included_at IS NOT NULL) AND (checkpointed_at IS NULL)) OR ((status = 'checkpointed'::text) AND (lease_id IS NOT NULL) AND (leased_at IS NOT NULL) AND (model_request_id IS NOT NULL) AND (included_at IS NOT NULL) AND (checkpointed_at IS NOT NULL)))),
    CONSTRAINT platform_run_inputs_sequence_check CHECK ((input_sequence > 0)),
    CONSTRAINT platform_run_inputs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'leased'::text, 'included'::text, 'checkpointed'::text])))
);


--
-- Name: platform_run_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_run_records (
    record_id text NOT NULL,
    run_id text NOT NULL,
    thread_id text,
    sequence integer NOT NULL,
    record_type text NOT NULL,
    payload_json jsonb NOT NULL,
    trace_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_run_records_sequence_check CHECK ((sequence > 0))
);


--
-- Name: platform_run_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_run_snapshots (
    run_id text NOT NULL,
    sequence integer DEFAULT 0 NOT NULL,
    snapshot_schema_version integer NOT NULL,
    state_json jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_run_snapshots_sequence_check CHECK ((sequence >= 0)),
    CONSTRAINT platform_run_snapshots_snapshot_schema_version_check CHECK ((snapshot_schema_version > 0))
);


--
-- Name: platform_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_runs (
    run_id text NOT NULL,
    run_kind text DEFAULT 'root'::text NOT NULL,
    root_run_id text NOT NULL,
    parent_run_id text,
    parent_turn_id text,
    root_turn_id text,
    spawn_call_id text,
    agent_path text DEFAULT '/root'::text NOT NULL,
    task_name text,
    agent_role text,
    spawn_depth integer DEFAULT 0 NOT NULL,
    fork_mode text DEFAULT 'none'::text NOT NULL,
    fork_turn_count integer,
    model_override text,
    reasoning_override text,
    max_model_tokens integer,
    max_wall_clock_ms integer,
    used_model_tokens integer DEFAULT 0 NOT NULL,
    next_agent_message_sequence integer DEFAULT 1 NOT NULL,
    session_id text NOT NULL,
    thread_id text,
    workspace_id text,
    created_by_user_id text,
    visibility text DEFAULT 'workspace'::text NOT NULL,
    user_query text NOT NULL,
    model_provider text,
    model_name text,
    status text DEFAULT 'queued'::text NOT NULL,
    runtime_config_json jsonb,
    active_entry_id text,
    pending_tool_call_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    recovery_status text DEFAULT 'clean'::text NOT NULL,
    orchestration_engine text,
    sdk_state_content_hash text,
    sdk_version text,
    runtime_config_digest text,
    sdk_state_schema_version integer,
    sdk_state_updated_at timestamp with time zone,
    next_record_sequence integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    next_input_sequence integer DEFAULT 1 NOT NULL,
    checkpoint_input_cursor integer DEFAULT 0 NOT NULL,
    active_input_lease_id text,
    active_input_lease_from integer,
    active_input_lease_to integer,
    terminal_input_claim_id text,
    terminal_objective_revision integer,
    terminal_input_cursor integer,
    terminal_claimed_at timestamp with time zone,
    CONSTRAINT platform_runs_identity_check CHECK (((run_kind = 'root'::text) AND (root_run_id = run_id) AND (parent_run_id IS NULL) AND (parent_turn_id IS NULL) AND (root_turn_id IS NULL) AND (spawn_call_id IS NULL) AND (agent_path = '/root'::text) AND (task_name IS NULL) AND (agent_role IS NULL) AND (spawn_depth = 0) AND (fork_mode = 'none'::text) AND (fork_turn_count IS NULL)) OR ((run_kind = 'child'::text) AND (root_run_id <> run_id) AND (parent_run_id IS NOT NULL) AND (parent_run_id <> run_id) AND (parent_turn_id IS NOT NULL) AND (root_turn_id IS NOT NULL) AND (spawn_call_id IS NOT NULL) AND (agent_path ~ '^/root(/[a-z0-9_]+)+$'::text) AND (task_name ~ '^[a-z0-9_]+$'::text) AND (agent_role IS NOT NULL) AND (spawn_depth > 0) AND (fork_mode = ANY (ARRAY['none'::text, 'full_history'::text, 'last_n_turns'::text])) AND ((fork_mode = 'last_n_turns'::text) = (fork_turn_count IS NOT NULL)))),
    CONSTRAINT platform_runs_budget_check CHECK (((used_model_tokens >= 0) AND ((max_model_tokens IS NULL) OR (max_model_tokens > 0)) AND ((max_wall_clock_ms IS NULL) OR (max_wall_clock_ms > 0)) AND ((max_model_tokens IS NULL) OR (used_model_tokens <= max_model_tokens)) AND (next_agent_message_sequence > 0))),
    CONSTRAINT platform_runs_input_cursor_check CHECK (((next_input_sequence > 0) AND (checkpoint_input_cursor >= 0) AND (checkpoint_input_cursor < next_input_sequence) AND (((active_input_lease_id IS NULL) AND (active_input_lease_from IS NULL) AND (active_input_lease_to IS NULL)) OR ((active_input_lease_id IS NOT NULL) AND (active_input_lease_from = (checkpoint_input_cursor + 1)) AND (active_input_lease_to >= active_input_lease_from) AND (active_input_lease_to < next_input_sequence))))),
    CONSTRAINT platform_runs_next_record_sequence_check CHECK ((next_record_sequence > 0)),
    CONSTRAINT platform_runs_terminal_input_claim_check CHECK ((((terminal_input_claim_id IS NULL) AND (terminal_objective_revision IS NULL) AND (terminal_input_cursor IS NULL) AND (terminal_claimed_at IS NULL)) OR ((terminal_input_claim_id IS NOT NULL) AND (terminal_objective_revision = next_input_sequence) AND (terminal_input_cursor = checkpoint_input_cursor) AND (active_input_lease_id IS NULL) AND (terminal_claimed_at IS NOT NULL))))
);


--
-- Name: platform_root_run_budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_root_run_budgets (
    root_run_id text NOT NULL,
    max_concurrent_children integer DEFAULT 3 NOT NULL,
    max_spawn_depth integer DEFAULT 3 NOT NULL,
    max_total_children integer DEFAULT 12 NOT NULL,
    max_total_model_tokens integer,
    max_wall_clock_ms integer,
    total_children integer DEFAULT 0 NOT NULL,
    active_children integer DEFAULT 0 NOT NULL,
    used_model_tokens integer DEFAULT 0 NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_root_run_budgets_counters_check CHECK (((max_concurrent_children > 0) AND (max_spawn_depth >= 0) AND (max_total_children > 0) AND (total_children >= 0) AND (active_children >= 0) AND (active_children <= total_children) AND (active_children <= max_concurrent_children) AND (total_children <= max_total_children) AND (used_model_tokens >= 0) AND ((max_total_model_tokens IS NULL) OR (max_total_model_tokens > 0)) AND ((max_wall_clock_ms IS NULL) OR (max_wall_clock_ms > 0)) AND ((max_total_model_tokens IS NULL) OR (used_model_tokens <= max_total_model_tokens)) AND (version >= 0)))
);


--
-- Name: platform_agent_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_agent_messages (
    message_id text NOT NULL,
    root_run_id text NOT NULL,
    sender_run_id text NOT NULL,
    receiver_run_id text NOT NULL,
    parent_turn_id text NOT NULL,
    root_turn_id text NOT NULL,
    sequence integer NOT NULL,
    kind text NOT NULL,
    content text NOT NULL,
    trigger_turn boolean DEFAULT false NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    checkpointed_at timestamp with time zone,
    CONSTRAINT platform_agent_messages_state_check CHECK (((sender_run_id <> receiver_run_id) AND (sequence > 0) AND (length(content) > 0) AND (kind = ANY (ARRAY['input'::text, 'message'::text, 'completion'::text])) AND (status = ANY (ARRAY['queued'::text, 'delivered'::text, 'checkpointed'::text])) AND (((status = 'queued'::text) AND (delivered_at IS NULL) AND (checkpointed_at IS NULL)) OR ((status = 'delivered'::text) AND (delivered_at IS NOT NULL) AND (checkpointed_at IS NULL)) OR ((status = 'checkpointed'::text) AND (delivered_at IS NOT NULL) AND (checkpointed_at IS NOT NULL)))))
);


--
-- Name: platform_runtime_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_runtime_config (
    config_key text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    payload_json jsonb NOT NULL,
    CONSTRAINT platform_runtime_config_revision_check CHECK ((revision > 0))
);


--
-- Name: platform_scheduled_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_scheduled_tasks (
    task_id text NOT NULL,
    target_kind text NOT NULL,
    target_id text NOT NULL,
    workspace_id text NOT NULL,
    created_by_user_id text NOT NULL,
    title text NOT NULL,
    prompt text NOT NULL,
    parameters_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    cron text NOT NULL,
    timezone text NOT NULL,
    recurring boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_fired_at timestamp with time zone,
    next_fire_at timestamp with time zone,
    last_run_id text,
    queue_job_id text,
    failure_count integer DEFAULT 0 NOT NULL,
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_scheduled_tasks_failure_count_check CHECK ((failure_count >= 0)),
    CONSTRAINT platform_scheduled_tasks_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'missed'::text, 'failed'::text, 'deleted'::text]))),
    CONSTRAINT platform_scheduled_tasks_target_kind_check CHECK ((target_kind = 'automation'::text))
);


--
-- Name: platform_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_sessions (
    session_id text NOT NULL,
    workspace_id text,
    created_by_user_id text,
    visibility text DEFAULT 'workspace'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    latest_thread_id text,
    latest_run_id text,
    latest_uploaded_layer_key text,
    latest_meteorological_dataset_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_thread_compactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_thread_compactions (
    compaction_id text NOT NULL,
    thread_id text NOT NULL,
    boundary_entry_id text NOT NULL,
    summary_entry_id text NOT NULL,
    first_compacted_entry_id text NOT NULL,
    last_compacted_entry_id text NOT NULL,
    preserved_from_entry_id text,
    source_digest text NOT NULL,
    source_entry_ids_json jsonb NOT NULL,
    source_unit_ids_json jsonb NOT NULL,
    source_object_hashes_json jsonb NOT NULL,
    summary text NOT NULL,
    strategy text NOT NULL,
    summary_provider text NOT NULL,
    summary_model text NOT NULL,
    prompt_version text NOT NULL,
    pre_tokens integer NOT NULL,
    post_tokens integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_thread_compactions_source_digest_check CHECK ((source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT platform_thread_compactions_source_entry_ids_json_check CHECK (((jsonb_typeof(source_entry_ids_json) = 'array'::text) AND (jsonb_array_length(source_entry_ids_json) > 0))),
    CONSTRAINT platform_thread_compactions_source_unit_ids_json_check CHECK (((jsonb_typeof(source_unit_ids_json) = 'array'::text) AND (jsonb_array_length(source_unit_ids_json) > 0))),
    CONSTRAINT platform_thread_compactions_source_object_hashes_json_check CHECK (((jsonb_typeof(source_object_hashes_json) = 'array'::text) AND (jsonb_array_length(source_object_hashes_json) > 0))),
    CONSTRAINT platform_thread_compactions_post_tokens_check CHECK ((post_tokens >= 0)),
    CONSTRAINT platform_thread_compactions_pre_tokens_check CHECK ((pre_tokens >= 0))
);


--
-- Name: platform_thread_memory_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_thread_memory_versions (
    thread_id text NOT NULL,
    version integer NOT NULL,
    content_hash text NOT NULL,
    source text NOT NULL,
    based_on_entry_id text,
    estimated_tokens integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_thread_memory_versions_content_hash_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT platform_thread_memory_versions_estimated_tokens_check CHECK ((estimated_tokens >= 0)),
    CONSTRAINT platform_thread_memory_versions_version_check CHECK ((version > 0))
);


--
-- Name: platform_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_threads (
    thread_id text NOT NULL,
    session_id text NOT NULL,
    workspace_id text,
    created_by_user_id text,
    visibility text DEFAULT 'workspace'::text NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    latest_run_id text,
    latest_user_query text,
    latest_assistant_summary text,
    latest_run_status text,
    latest_artifact_id text,
    latest_artifact_name text,
    history_preview text,
    run_count integer DEFAULT 0 NOT NULL,
    next_entry_sequence integer DEFAULT 1 NOT NULL,
    active_leaf_entry_id text,
    transcript_entry_count integer DEFAULT 0 NOT NULL,
    estimated_context_tokens integer DEFAULT 0 NOT NULL,
    latest_compaction_id text,
    memory_version integer DEFAULT 0 NOT NULL,
    memory_based_on_tokens integer DEFAULT 0 NOT NULL,
    forked_from_thread_id text,
    forked_from_entry_id text,
    quarantined boolean DEFAULT false NOT NULL,
    quarantine_reason text,
    deleted_at timestamp with time zone,
    purge_after timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_threads_next_entry_sequence_check CHECK ((next_entry_sequence > 0))
);


--
-- Name: platform_tool_invocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_tool_invocations (
    invocation_id text NOT NULL,
    run_id text NOT NULL,
    turn_id text NOT NULL,
    call_id text NOT NULL,
    step_id text,
    tool_name text NOT NULL,
    tool_kind text NOT NULL,
    execution_surface text NOT NULL,
    objective_revision integer NOT NULL,
    tool_plan_digest text NOT NULL,
    descriptor_digest text NOT NULL,
    args_digest text NOT NULL,
    effect text NOT NULL,
    replay_policy text NOT NULL,
    idempotency_key text,
    approval_action text,
    approval_decision text,
    status text NOT NULL,
    terminal_outcome text,
    result_id text,
    error text,
    prepared_at timestamp with time zone DEFAULT now() NOT NULL,
    running_at timestamp with time zone,
    terminal_at timestamp with time zone,
    checkpointed_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT platform_tool_invocations_pkey PRIMARY KEY (invocation_id),
    CONSTRAINT platform_tool_invocations_run_call_unique UNIQUE (run_id, call_id),
    CONSTRAINT platform_tool_invocations_objective_revision_check CHECK ((objective_revision > 0)),
    CONSTRAINT platform_tool_invocations_version_check CHECK ((version > 0)),
    CONSTRAINT platform_tool_invocations_kind_check CHECK ((tool_kind = ANY (ARRAY['platform'::text, 'subagent'::text, 'handoff'::text, 'mcp'::text, 'hosted'::text, 'sandbox'::text, 'unavailable'::text]))),
    CONSTRAINT platform_tool_invocations_surface_check CHECK ((execution_surface = ANY (ARRAY['agent'::text, 'automation'::text, 'developer'::text]))),
    CONSTRAINT platform_tool_invocations_effect_check CHECK ((effect = ANY (ARRAY['read'::text, 'world_write'::text, 'external_write'::text, 'destructive'::text]))),
    CONSTRAINT platform_tool_invocations_replay_policy_check CHECK ((replay_policy = ANY (ARRAY['safe'::text, 'idempotency_key'::text, 'manual_recovery'::text]))),
    CONSTRAINT platform_tool_invocations_approval_decision_check CHECK (((approval_decision IS NULL) OR (approval_decision = ANY (ARRAY['not_required'::text, 'approved'::text, 'rejected'::text])))),
    CONSTRAINT platform_tool_invocations_status_check CHECK ((status = ANY (ARRAY['prepared'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'rejected'::text, 'aborted'::text, 'checkpointed'::text]))),
    CONSTRAINT platform_tool_invocations_state_check CHECK (((status = 'prepared'::text) AND (running_at IS NULL) AND (terminal_at IS NULL) AND (checkpointed_at IS NULL) AND (result_id IS NULL) AND (error IS NULL) AND (terminal_outcome IS NULL)) OR ((status = 'running'::text) AND (running_at IS NOT NULL) AND (terminal_at IS NULL) AND (checkpointed_at IS NULL) AND (result_id IS NULL) AND (error IS NULL) AND (terminal_outcome IS NULL)) OR ((status = 'succeeded'::text) AND (running_at IS NOT NULL) AND (terminal_at IS NOT NULL) AND (checkpointed_at IS NULL) AND (error IS NULL) AND (terminal_outcome = 'succeeded'::text)) OR ((status = ANY (ARRAY['failed'::text, 'rejected'::text, 'aborted'::text])) AND (terminal_at IS NOT NULL) AND (checkpointed_at IS NULL) AND (result_id IS NULL) AND (error IS NOT NULL) AND (terminal_outcome = status)) OR ((status = 'checkpointed'::text) AND (terminal_at IS NOT NULL) AND (checkpointed_at IS NOT NULL) AND (terminal_outcome = ANY (ARRAY['succeeded'::text, 'failed'::text, 'rejected'::text, 'aborted'::text])) AND (((terminal_outcome = 'succeeded'::text) AND (error IS NULL)) OR ((terminal_outcome <> 'succeeded'::text) AND (error IS NOT NULL)))))
);


CREATE INDEX idx_tool_invocations_run_status ON public.platform_tool_invocations USING btree (run_id, status, prepared_at);


--
-- Name: platform_approval_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_approval_records (
    approval_id text NOT NULL,
    run_id text NOT NULL,
    thread_id text NOT NULL,
    session_id text NOT NULL,
    workspace_id text NOT NULL,
    invocation_id text NOT NULL,
    call_id text NOT NULL,
    step_id text NOT NULL,
    context_digest text NOT NULL,
    action_key text NOT NULL,
    action_json jsonb NOT NULL,
    status text NOT NULL,
    decision text,
    decision_scope text,
    decision_reason text,
    decided_by_user_id text,
    source_approval_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    consumed_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT platform_approval_records_pkey PRIMARY KEY (approval_id),
    CONSTRAINT platform_approval_records_run_call_unique UNIQUE (run_id, call_id),
    CONSTRAINT platform_approval_records_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'resolved'::text, 'consumed'::text]))),
    CONSTRAINT platform_approval_records_decision_check CHECK (((decision IS NULL) OR (decision = ANY (ARRAY['approved'::text, 'rejected'::text])))),
    CONSTRAINT platform_approval_records_scope_check CHECK (((decision_scope IS NULL) OR (decision_scope = ANY (ARRAY['exact_call'::text, 'session'::text])))),
    CONSTRAINT platform_approval_records_version_check CHECK ((version > 0)),
    CONSTRAINT platform_approval_records_state_check CHECK (((status = 'pending'::text) AND (decision IS NULL) AND (decision_scope IS NULL) AND (resolved_at IS NULL) AND (consumed_at IS NULL)) OR ((status = 'resolved'::text) AND (decision IS NOT NULL) AND (decision_scope IS NOT NULL) AND (resolved_at IS NOT NULL) AND (consumed_at IS NULL)) OR ((status = 'consumed'::text) AND (decision IS NOT NULL) AND (decision_scope IS NOT NULL) AND (resolved_at IS NOT NULL) AND (consumed_at IS NOT NULL))),
    CONSTRAINT platform_approval_records_rejected_scope_check CHECK (((decision <> 'rejected'::text) OR ((decision_scope = 'exact_call'::text) AND (decision_reason IS NOT NULL))))
);


CREATE INDEX idx_approval_records_run_status ON public.platform_approval_records USING btree (run_id, status, created_at);
CREATE INDEX idx_approval_records_session_action ON public.platform_approval_records USING btree (session_id, action_key, status, created_at);


--
-- Name: platform_tool_result_commits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_tool_result_commits (
    run_id text NOT NULL,
    invocation_id text NOT NULL,
    result_id text NOT NULL,
    committed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_users (
    user_id text NOT NULL,
    subject text NOT NULL,
    email text NOT NULL,
    display_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_workspaces (
    workspace_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by_user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tool_catalog_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_catalog_entries (
    tool_name text NOT NULL,
    tool_kind text NOT NULL,
    payload_json jsonb NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);


--
-- Name: auth_account auth_account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_account
    ADD CONSTRAINT auth_account_pkey PRIMARY KEY (id);


--
-- Name: auth_session auth_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_pkey PRIMARY KEY (id);


--
-- Name: auth_user auth_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_pkey PRIMARY KEY (id);


--
-- Name: auth_verification auth_verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_verification
    ADD CONSTRAINT auth_verification_pkey PRIMARY KEY (id);


--
-- Name: platform_context_windows platform_context_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_context_windows
    ADD CONSTRAINT platform_context_windows_pkey PRIMARY KEY (context_window_id);


--
-- Name: platform_agent_step_contexts idx_agent_step_contexts_run_request_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_agent_step_contexts
    ADD CONSTRAINT idx_agent_step_contexts_run_request_unique UNIQUE (run_id, model_request_index);


--
-- Name: platform_geo_world_diffs idx_geo_world_diffs_run_to_revision_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_geo_world_diffs
    ADD CONSTRAINT idx_geo_world_diffs_run_to_revision_unique UNIQUE (run_id, to_revision);


--
-- Name: platform_run_domain_events idx_run_domain_events_run_sequence_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_domain_events
    ADD CONSTRAINT idx_run_domain_events_run_sequence_unique UNIQUE (run_id, sequence);


--
-- Name: platform_agent_step_contexts platform_agent_step_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_agent_step_contexts
    ADD CONSTRAINT platform_agent_step_contexts_pkey PRIMARY KEY (step_id);


--
-- Name: platform_artifacts platform_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_artifacts
    ADD CONSTRAINT platform_artifacts_pkey PRIMARY KEY (artifact_id);


--
-- Name: platform_audit_events platform_audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_events
    ADD CONSTRAINT platform_audit_events_pkey PRIMARY KEY (audit_event_id);


--
-- Name: platform_automation_definitions platform_automation_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_automation_definitions
    ADD CONSTRAINT platform_automation_definitions_pkey PRIMARY KEY (automation_id);


--
-- Name: platform_automation_runs platform_automation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_automation_runs
    ADD CONSTRAINT platform_automation_runs_pkey PRIMARY KEY (automation_run_id);


--
-- Name: platform_automation_versions platform_automation_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_automation_versions
    ADD CONSTRAINT platform_automation_versions_pkey PRIMARY KEY (automation_id, revision);


--
-- Name: platform_conversation_entries platform_conversation_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_conversation_entries
    ADD CONSTRAINT platform_conversation_entries_pkey PRIMARY KEY (entry_id);


--
-- Name: platform_event_outbox platform_event_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_event_outbox
    ADD CONSTRAINT platform_event_outbox_pkey PRIMARY KEY (outbox_id);


--
-- Name: platform_file_objects platform_file_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_file_objects
    ADD CONSTRAINT platform_file_objects_pkey PRIMARY KEY (file_id);


--
-- Name: platform_geo_world_diffs platform_geo_world_diffs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_geo_world_diffs
    ADD CONSTRAINT platform_geo_world_diffs_pkey PRIMARY KEY (diff_id);


--
-- Name: platform_geo_world_snapshots platform_geo_world_snapshots_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_geo_world_snapshots
    ADD CONSTRAINT platform_geo_world_snapshots_pk PRIMARY KEY (run_id, revision);


--
-- Name: platform_layer_features platform_layer_features_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_layer_features
    ADD CONSTRAINT platform_layer_features_pkey PRIMARY KEY (map_layer_id, feature_id);


--
-- Name: platform_map_layers platform_map_layers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_map_layers
    ADD CONSTRAINT platform_map_layers_pkey PRIMARY KEY (map_layer_id);


--
-- Name: platform_map_scene_layers platform_map_scene_layers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_map_scene_layers
    ADD CONSTRAINT platform_map_scene_layers_pkey PRIMARY KEY (scene_id, map_layer_id);


--
-- Name: platform_map_scene_layers platform_map_scene_layers_scene_id_layer_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_map_scene_layers
    ADD CONSTRAINT platform_map_scene_layers_scene_id_layer_order_key UNIQUE (scene_id, layer_order);


--
-- Name: platform_map_scenes platform_map_scenes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_map_scenes
    ADD CONSTRAINT platform_map_scenes_pkey PRIMARY KEY (scene_id);


--
-- Name: platform_map_scenes platform_map_scenes_thread_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_map_scenes
    ADD CONSTRAINT platform_map_scenes_thread_id_key UNIQUE (thread_id);


--
-- Name: platform_memberships platform_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_memberships
    ADD CONSTRAINT platform_memberships_pkey PRIMARY KEY (membership_id);


--
-- Name: platform_meteorological_datasets platform_meteorological_datasets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_meteorological_datasets
    ADD CONSTRAINT platform_meteorological_datasets_pkey PRIMARY KEY (dataset_id);


--
-- Name: platform_meteorological_jobs platform_meteorological_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_meteorological_jobs
    ADD CONSTRAINT platform_meteorological_jobs_pkey PRIMARY KEY (job_id);


--
-- Name: platform_model_providers platform_model_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_model_providers
    ADD CONSTRAINT platform_model_providers_pkey PRIMARY KEY (provider_id);


--
-- Name: platform_model_request_records platform_model_request_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_model_request_records
    ADD CONSTRAINT platform_model_request_records_pkey PRIMARY KEY (request_id);


--
-- Name: platform_model_request_records platform_model_request_records_run_id_step_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_model_request_records
    ADD CONSTRAINT platform_model_request_records_run_id_step_id_key UNIQUE (run_id, step_id);


--
-- Name: platform_model_result_cache platform_model_result_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_model_result_cache
    ADD CONSTRAINT platform_model_result_cache_pkey PRIMARY KEY (cache_key);


--
-- Name: platform_rbac_policies platform_rbac_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_rbac_policies
    ADD CONSTRAINT platform_rbac_policies_pkey PRIMARY KEY (policy_id);


--
-- Name: platform_run_domain_events platform_run_domain_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_domain_events
    ADD CONSTRAINT platform_run_domain_events_pkey PRIMARY KEY (event_id);


--
-- Name: platform_run_inputs platform_run_inputs_entry_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_inputs
    ADD CONSTRAINT platform_run_inputs_entry_id_key UNIQUE (entry_id);


--
-- Name: platform_run_inputs platform_run_inputs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_inputs
    ADD CONSTRAINT platform_run_inputs_pkey PRIMARY KEY (input_id);


--
-- Name: platform_run_inputs platform_run_inputs_run_sequence_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_inputs
    ADD CONSTRAINT platform_run_inputs_run_sequence_unique UNIQUE (run_id, input_sequence);


--
-- Name: platform_run_records platform_run_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_records
    ADD CONSTRAINT platform_run_records_pkey PRIMARY KEY (record_id);


--
-- Name: platform_run_records platform_run_records_run_id_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_records
    ADD CONSTRAINT platform_run_records_run_id_sequence_key UNIQUE (run_id, sequence);


--
-- Name: platform_run_snapshots platform_run_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_snapshots
    ADD CONSTRAINT platform_run_snapshots_pkey PRIMARY KEY (run_id);


--
-- Name: platform_agent_messages platform_agent_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_agent_messages
    ADD CONSTRAINT platform_agent_messages_pkey PRIMARY KEY (message_id);


--
-- Name: platform_root_run_budgets platform_root_run_budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_root_run_budgets
    ADD CONSTRAINT platform_root_run_budgets_pkey PRIMARY KEY (root_run_id);


--
-- Name: platform_runs platform_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_runs
    ADD CONSTRAINT platform_runs_pkey PRIMARY KEY (run_id);


--
-- Name: platform_runtime_config platform_runtime_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_runtime_config
    ADD CONSTRAINT platform_runtime_config_pkey PRIMARY KEY (config_key);


--
-- Name: platform_scheduled_tasks platform_scheduled_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_scheduled_tasks
    ADD CONSTRAINT platform_scheduled_tasks_pkey PRIMARY KEY (task_id);


--
-- Name: platform_sessions platform_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_sessions
    ADD CONSTRAINT platform_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: platform_thread_compactions platform_thread_compactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_thread_compactions
    ADD CONSTRAINT platform_thread_compactions_pkey PRIMARY KEY (compaction_id);


--
-- Name: platform_thread_memory_versions platform_thread_memory_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_thread_memory_versions
    ADD CONSTRAINT platform_thread_memory_versions_pkey PRIMARY KEY (thread_id, version);


--
-- Name: platform_threads platform_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_threads
    ADD CONSTRAINT platform_threads_pkey PRIMARY KEY (thread_id);


--
-- Name: platform_tool_result_commits platform_tool_result_commits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_tool_result_commits
    ADD CONSTRAINT platform_tool_result_commits_pkey PRIMARY KEY (run_id, invocation_id);


--
-- Name: platform_users platform_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_users
    ADD CONSTRAINT platform_users_pkey PRIMARY KEY (user_id);


--
-- Name: platform_workspaces platform_workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_workspaces
    ADD CONSTRAINT platform_workspaces_pkey PRIMARY KEY (workspace_id);


--
-- Name: tool_catalog_entries tool_catalog_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_catalog_entries
    ADD CONSTRAINT tool_catalog_entries_pkey PRIMARY KEY (tool_name, tool_kind);


--
-- Name: idx_agent_step_contexts_turn_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_step_contexts_turn_request ON public.platform_agent_step_contexts USING btree (turn_id, model_request_index);


--
-- Name: idx_auth_account_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_account_user_id ON public.auth_account USING btree (user_id);


--
-- Name: idx_auth_session_token_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_auth_session_token_unique ON public.auth_session USING btree (token);


--
-- Name: idx_auth_session_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_session_user_id ON public.auth_session USING btree (user_id);


--
-- Name: idx_auth_user_email_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_auth_user_email_unique ON public.auth_user USING btree (email);


--
-- Name: idx_auth_verification_identifier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_verification_identifier ON public.auth_verification USING btree (identifier);


--
-- Name: idx_automation_definitions_source_lifecycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_definitions_source_lifecycle ON public.platform_automation_definitions USING btree (source, lifecycle);


--
-- Name: idx_automation_definitions_workspace_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_definitions_workspace_updated ON public.platform_automation_definitions USING btree (workspace_id, updated_at);


--
-- Name: idx_automation_runs_scheduled_task_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_runs_scheduled_task_started ON public.platform_automation_runs USING btree (scheduled_task_id, started_at);


--
-- Name: idx_automation_runs_workspace_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_runs_workspace_started ON public.platform_automation_runs USING btree (workspace_id, started_at);


--
-- Name: idx_automation_versions_lifecycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_versions_lifecycle ON public.platform_automation_versions USING btree (automation_id, lifecycle);


--
-- Name: idx_context_windows_active_run_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_context_windows_active_run_unique ON public.platform_context_windows USING btree (run_id) WHERE (closed_at IS NULL);


--
-- Name: idx_context_windows_run_generation_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_context_windows_run_generation_unique ON public.platform_context_windows USING btree (run_id, generation);


--
-- Name: idx_conversation_entries_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_entries_parent ON public.platform_conversation_entries USING btree (parent_entry_id);


--
-- Name: idx_conversation_entries_run_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_entries_run_created ON public.platform_conversation_entries USING btree (run_id, created_at);


--
-- Name: idx_conversation_entries_thread_sequence_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_conversation_entries_thread_sequence_unique ON public.platform_conversation_entries USING btree (thread_id, sequence);


--
-- Name: idx_event_outbox_aggregate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_outbox_aggregate ON public.platform_event_outbox USING btree (aggregate_type, aggregate_id, created_at);


--
-- Name: idx_event_outbox_unpublished; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_outbox_unpublished ON public.platform_event_outbox USING btree (published_at, created_at);


--
-- Name: idx_geo_world_snapshots_workspace_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_geo_world_snapshots_workspace_created ON public.platform_geo_world_snapshots USING btree (workspace_id, created_at);


--
-- Name: idx_meteorological_datasets_session_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meteorological_datasets_session_updated ON public.platform_meteorological_datasets USING btree (session_id, updated_at);


--
-- Name: idx_meteorological_datasets_thread_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meteorological_datasets_thread_updated ON public.platform_meteorological_datasets USING btree (thread_id, updated_at);


--
-- Name: idx_meteorological_jobs_dataset_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meteorological_jobs_dataset_updated ON public.platform_meteorological_jobs USING btree (dataset_id, updated_at);


--
-- Name: idx_meteorological_jobs_session_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meteorological_jobs_session_updated ON public.platform_meteorological_jobs USING btree (session_id, updated_at);


--
-- Name: idx_model_result_cache_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_result_cache_expiry ON public.platform_model_result_cache USING btree (expires_at);


--
-- Name: idx_model_result_cache_workspace_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_result_cache_workspace_expiry ON public.platform_model_result_cache USING btree (workspace_id, expires_at);


--
-- Name: idx_platform_artifacts_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_artifacts_run_id ON public.platform_artifacts USING btree (run_id);


--
-- Name: idx_platform_audit_actor_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_audit_actor_created ON public.platform_audit_events USING btree (actor_user_id, created_at);


--
-- Name: idx_platform_audit_workspace_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_audit_workspace_created ON public.platform_audit_events USING btree (workspace_id, created_at);


--
-- Name: idx_platform_file_objects_content_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_file_objects_content_hash ON public.platform_file_objects USING btree (content_hash);


--
-- Name: idx_platform_file_objects_thread_request_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_platform_file_objects_thread_request_unique ON public.platform_file_objects USING btree (thread_id, request_id) WHERE (request_id IS NOT NULL);


--
-- Name: idx_platform_file_objects_thread_source_ready_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_platform_file_objects_thread_source_ready_unique ON public.platform_file_objects USING btree (thread_id, source_key) WHERE (status = 'ready'::text);


--
-- Name: idx_platform_file_objects_thread_status_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_file_objects_thread_status_updated ON public.platform_file_objects USING btree (thread_id, status, updated_at);


--
-- Name: idx_platform_layer_features_geometry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_layer_features_geometry ON public.platform_layer_features USING gist (geometry);


--
-- Name: idx_platform_layer_features_layer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_layer_features_layer ON public.platform_layer_features USING btree (map_layer_id);


--
-- Name: idx_platform_map_layers_artifact_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_platform_map_layers_artifact_unique ON public.platform_map_layers USING btree (artifact_id);


--
-- Name: idx_platform_map_layers_managed_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_platform_map_layers_managed_unique ON public.platform_map_layers USING btree (managed_layer_key);


--
-- Name: idx_platform_map_layers_thread_replacement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_map_layers_thread_replacement ON public.platform_map_layers USING btree (thread_id, replacement_group, updated_at);


--
-- Name: idx_platform_map_layers_thread_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_map_layers_thread_updated ON public.platform_map_layers USING btree (thread_id, updated_at);


--
-- Name: idx_platform_map_layers_workspace_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_map_layers_workspace_updated ON public.platform_map_layers USING btree (workspace_id, updated_at);


--
-- Name: idx_platform_map_scenes_workspace_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_map_scenes_workspace_updated ON public.platform_map_scenes USING btree (workspace_id, updated_at);


--
-- Name: idx_platform_memberships_member_role_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_platform_memberships_member_role_unique ON public.platform_memberships USING btree (workspace_id, user_id, role);


--
-- Name: idx_platform_memberships_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_memberships_user ON public.platform_memberships USING btree (user_id);


--
-- Name: idx_platform_memberships_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_memberships_workspace ON public.platform_memberships USING btree (workspace_id);


--
-- Name: idx_platform_model_providers_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_model_providers_created_by ON public.platform_model_providers USING btree (created_by_user_id);


--
-- Name: idx_platform_rbac_policy_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_platform_rbac_policy_unique ON public.platform_rbac_policies USING btree (ptype, v0, v1, v2, v3, v4, v5);


--
-- Name: idx_platform_runs_session_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_runs_session_updated ON public.platform_runs USING btree (session_id, updated_at);


--
-- Name: idx_platform_runs_status_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_runs_status_updated ON public.platform_runs USING btree (status, updated_at);


--
-- Name: idx_platform_runs_thread_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_runs_thread_updated ON public.platform_runs USING btree (thread_id, updated_at);


--
-- Name: idx_platform_runs_workspace_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_runs_workspace_updated ON public.platform_runs USING btree (workspace_id, updated_at);


--
-- Name: idx_platform_runs_parent_spawn_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_platform_runs_parent_spawn_unique ON public.platform_runs USING btree (parent_run_id, spawn_call_id);


--
-- Name: idx_platform_runs_root_agent_path_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_platform_runs_root_agent_path_unique ON public.platform_runs USING btree (root_run_id, agent_path);


--
-- Name: idx_platform_agent_messages_receiver_sequence_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_platform_agent_messages_receiver_sequence_unique ON public.platform_agent_messages USING btree (receiver_run_id, sequence);


--
-- Name: idx_platform_agent_messages_receiver_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_agent_messages_receiver_status ON public.platform_agent_messages USING btree (receiver_run_id, status, sequence);


--
-- Name: idx_platform_sessions_owner_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_sessions_owner_updated ON public.platform_sessions USING btree (created_by_user_id, updated_at);


--
-- Name: idx_platform_sessions_workspace_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_sessions_workspace_updated ON public.platform_sessions USING btree (workspace_id, updated_at);


--
-- Name: idx_platform_threads_session_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_threads_session_updated ON public.platform_threads USING btree (session_id, updated_at);


--
-- Name: idx_platform_threads_workspace_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_threads_workspace_updated ON public.platform_threads USING btree (workspace_id, updated_at);


--
-- Name: idx_platform_users_email_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_platform_users_email_unique ON public.platform_users USING btree (email);


--
-- Name: idx_platform_users_subject_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_platform_users_subject_unique ON public.platform_users USING btree (subject);


--
-- Name: idx_run_domain_events_run_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_domain_events_run_type ON public.platform_run_domain_events USING btree (run_id, event_type, sequence);


--
-- Name: idx_run_inputs_run_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_inputs_run_lease ON public.platform_run_inputs USING btree (run_id, lease_id) WHERE (lease_id IS NOT NULL);


--
-- Name: idx_run_inputs_run_model_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_inputs_run_model_request ON public.platform_run_inputs USING btree (run_id, model_request_id);


--
-- Name: idx_run_inputs_run_status_queued; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_inputs_run_status_queued ON public.platform_run_inputs USING btree (run_id, status, input_sequence);


--
-- Name: idx_model_request_records_run_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_request_records_run_created ON public.platform_model_request_records USING btree (run_id, created_at);


--
-- Name: idx_run_records_run_type_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_records_run_type_created ON public.platform_run_records USING btree (run_id, record_type, created_at);


--
-- Name: idx_run_records_trace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_run_records_trace ON public.platform_run_records USING btree (trace_id);


--
-- Name: idx_scheduled_tasks_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduled_tasks_target ON public.platform_scheduled_tasks USING btree (target_kind, target_id);


--
-- Name: idx_scheduled_tasks_workspace_next; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduled_tasks_workspace_next ON public.platform_scheduled_tasks USING btree (workspace_id, next_fire_at);


--
-- Name: idx_thread_compactions_thread_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_thread_compactions_thread_created ON public.platform_thread_compactions USING btree (thread_id, created_at);


--
-- Name: idx_thread_memory_versions_thread_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_thread_memory_versions_thread_created ON public.platform_thread_memory_versions USING btree (thread_id, created_at);


--
-- Name: auth_account auth_account_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_account
    ADD CONSTRAINT auth_account_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;


--
-- Name: auth_session auth_session_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;


--
-- Name: platform_agent_step_contexts platform_agent_step_contexts_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_agent_step_contexts
    ADD CONSTRAINT platform_agent_step_contexts_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_agent_step_contexts platform_agent_step_contexts_world_snapshot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_agent_step_contexts
    ADD CONSTRAINT platform_agent_step_contexts_world_snapshot_fk FOREIGN KEY (run_id, world_revision) REFERENCES public.platform_geo_world_snapshots(run_id, revision) ON DELETE CASCADE;


--
-- Name: platform_context_windows platform_context_windows_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_context_windows
    ADD CONSTRAINT platform_context_windows_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_artifacts platform_artifacts_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_artifacts
    ADD CONSTRAINT platform_artifacts_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE SET NULL;


--
-- Name: platform_artifacts platform_artifacts_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_artifacts
    ADD CONSTRAINT platform_artifacts_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_artifacts platform_artifacts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_artifacts
    ADD CONSTRAINT platform_artifacts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_audit_events platform_audit_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_events
    ADD CONSTRAINT platform_audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.platform_users(user_id) ON DELETE SET NULL;


--
-- Name: platform_audit_events platform_audit_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_events
    ADD CONSTRAINT platform_audit_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE SET NULL;


--
-- Name: platform_automation_definitions platform_automation_definitions_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_automation_definitions
    ADD CONSTRAINT platform_automation_definitions_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE SET NULL;


--
-- Name: platform_automation_definitions platform_automation_definitions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_automation_definitions
    ADD CONSTRAINT platform_automation_definitions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_automation_runs platform_automation_runs_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_automation_runs
    ADD CONSTRAINT platform_automation_runs_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE RESTRICT;


--
-- Name: platform_automation_runs platform_automation_runs_definition_revision_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_automation_runs
    ADD CONSTRAINT platform_automation_runs_definition_revision_fk FOREIGN KEY (automation_id, automation_revision) REFERENCES public.platform_automation_versions(automation_id, revision) ON DELETE RESTRICT;


--
-- Name: platform_automation_runs platform_automation_runs_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_automation_runs
    ADD CONSTRAINT platform_automation_runs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE SET NULL;


--
-- Name: platform_automation_runs platform_automation_runs_scheduled_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_automation_runs
    ADD CONSTRAINT platform_automation_runs_scheduled_task_id_fkey FOREIGN KEY (scheduled_task_id) REFERENCES public.platform_scheduled_tasks(task_id) ON DELETE SET NULL;


--
-- Name: platform_automation_runs platform_automation_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_automation_runs
    ADD CONSTRAINT platform_automation_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_automation_versions platform_automation_versions_automation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_automation_versions
    ADD CONSTRAINT platform_automation_versions_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES public.platform_automation_definitions(automation_id) ON DELETE CASCADE;


--
-- Name: platform_automation_versions platform_automation_versions_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_automation_versions
    ADD CONSTRAINT platform_automation_versions_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE SET NULL;


--
-- Name: platform_conversation_entries platform_conversation_entries_logical_parent_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_conversation_entries
    ADD CONSTRAINT platform_conversation_entries_logical_parent_entry_id_fkey FOREIGN KEY (logical_parent_entry_id) REFERENCES public.platform_conversation_entries(entry_id) ON DELETE SET NULL;


--
-- Name: platform_conversation_entries platform_conversation_entries_parent_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_conversation_entries
    ADD CONSTRAINT platform_conversation_entries_parent_entry_id_fkey FOREIGN KEY (parent_entry_id) REFERENCES public.platform_conversation_entries(entry_id) ON DELETE SET NULL;


--
-- Name: platform_conversation_entries platform_conversation_entries_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_conversation_entries
    ADD CONSTRAINT platform_conversation_entries_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE SET NULL;


--
-- Name: platform_conversation_entries platform_conversation_entries_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_conversation_entries
    ADD CONSTRAINT platform_conversation_entries_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.platform_sessions(session_id) ON DELETE CASCADE;


--
-- Name: platform_conversation_entries platform_conversation_entries_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_conversation_entries
    ADD CONSTRAINT platform_conversation_entries_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.platform_threads(thread_id) ON DELETE CASCADE;


--
-- Name: platform_file_objects platform_file_objects_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_file_objects
    ADD CONSTRAINT platform_file_objects_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE SET NULL;


--
-- Name: platform_file_objects platform_file_objects_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_file_objects
    ADD CONSTRAINT platform_file_objects_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.platform_sessions(session_id) ON DELETE CASCADE;


--
-- Name: platform_file_objects platform_file_objects_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_file_objects
    ADD CONSTRAINT platform_file_objects_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.platform_threads(thread_id) ON DELETE CASCADE;


--
-- Name: platform_file_objects platform_file_objects_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_file_objects
    ADD CONSTRAINT platform_file_objects_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_geo_world_diffs platform_geo_world_diffs_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_geo_world_diffs
    ADD CONSTRAINT platform_geo_world_diffs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_geo_world_snapshots platform_geo_world_snapshots_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_geo_world_snapshots
    ADD CONSTRAINT platform_geo_world_snapshots_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_geo_world_snapshots platform_geo_world_snapshots_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_geo_world_snapshots
    ADD CONSTRAINT platform_geo_world_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_layer_features platform_layer_features_map_layer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_layer_features
    ADD CONSTRAINT platform_layer_features_map_layer_id_fkey FOREIGN KEY (map_layer_id) REFERENCES public.platform_map_layers(map_layer_id) ON DELETE CASCADE;


--
-- Name: platform_map_layers platform_map_layers_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_map_layers
    ADD CONSTRAINT platform_map_layers_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.platform_artifacts(artifact_id) ON DELETE CASCADE;


--
-- Name: platform_map_layers platform_map_layers_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_map_layers
    ADD CONSTRAINT platform_map_layers_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE SET NULL;


--
-- Name: platform_map_layers platform_map_layers_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_map_layers
    ADD CONSTRAINT platform_map_layers_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.platform_sessions(session_id) ON DELETE CASCADE;


--
-- Name: platform_map_layers platform_map_layers_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_map_layers
    ADD CONSTRAINT platform_map_layers_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.platform_threads(thread_id) ON DELETE CASCADE;


--
-- Name: platform_map_layers platform_map_layers_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_map_layers
    ADD CONSTRAINT platform_map_layers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_map_scene_layers platform_map_scene_layers_map_layer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_map_scene_layers
    ADD CONSTRAINT platform_map_scene_layers_map_layer_id_fkey FOREIGN KEY (map_layer_id) REFERENCES public.platform_map_layers(map_layer_id) ON DELETE CASCADE;


--
-- Name: platform_map_scene_layers platform_map_scene_layers_scene_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_map_scene_layers
    ADD CONSTRAINT platform_map_scene_layers_scene_id_fkey FOREIGN KEY (scene_id) REFERENCES public.platform_map_scenes(scene_id) ON DELETE CASCADE;


--
-- Name: platform_map_scenes platform_map_scenes_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_map_scenes
    ADD CONSTRAINT platform_map_scenes_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.platform_threads(thread_id) ON DELETE CASCADE;


--
-- Name: platform_map_scenes platform_map_scenes_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_map_scenes
    ADD CONSTRAINT platform_map_scenes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_memberships platform_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_memberships
    ADD CONSTRAINT platform_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.platform_users(user_id) ON DELETE CASCADE;


--
-- Name: platform_memberships platform_memberships_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_memberships
    ADD CONSTRAINT platform_memberships_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_meteorological_datasets platform_meteorological_datasets_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_meteorological_datasets
    ADD CONSTRAINT platform_meteorological_datasets_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE SET NULL;


--
-- Name: platform_meteorological_datasets platform_meteorological_datasets_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_meteorological_datasets
    ADD CONSTRAINT platform_meteorological_datasets_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.platform_sessions(session_id) ON DELETE CASCADE;


--
-- Name: platform_meteorological_datasets platform_meteorological_datasets_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_meteorological_datasets
    ADD CONSTRAINT platform_meteorological_datasets_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.platform_threads(thread_id) ON DELETE SET NULL;


--
-- Name: platform_meteorological_datasets platform_meteorological_datasets_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_meteorological_datasets
    ADD CONSTRAINT platform_meteorological_datasets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_meteorological_jobs platform_meteorological_jobs_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_meteorological_jobs
    ADD CONSTRAINT platform_meteorological_jobs_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE SET NULL;


--
-- Name: platform_meteorological_jobs platform_meteorological_jobs_dataset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_meteorological_jobs
    ADD CONSTRAINT platform_meteorological_jobs_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES public.platform_meteorological_datasets(dataset_id) ON DELETE CASCADE;


--
-- Name: platform_meteorological_jobs platform_meteorological_jobs_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_meteorological_jobs
    ADD CONSTRAINT platform_meteorological_jobs_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.platform_sessions(session_id) ON DELETE CASCADE;


--
-- Name: platform_meteorological_jobs platform_meteorological_jobs_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_meteorological_jobs
    ADD CONSTRAINT platform_meteorological_jobs_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.platform_threads(thread_id) ON DELETE SET NULL;


--
-- Name: platform_meteorological_jobs platform_meteorological_jobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_meteorological_jobs
    ADD CONSTRAINT platform_meteorological_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_model_providers platform_model_providers_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_model_providers
    ADD CONSTRAINT platform_model_providers_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE RESTRICT;


--
-- Name: platform_model_result_cache platform_model_result_cache_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_model_result_cache
    ADD CONSTRAINT platform_model_result_cache_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_model_request_records platform_model_request_records_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_model_request_records
    ADD CONSTRAINT platform_model_request_records_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_model_request_records platform_model_request_records_context_window_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_model_request_records
    ADD CONSTRAINT platform_model_request_records_context_window_id_fkey FOREIGN KEY (context_window_id) REFERENCES public.platform_context_windows(context_window_id) ON DELETE RESTRICT;


--
-- Name: platform_model_request_records platform_model_request_records_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_model_request_records
    ADD CONSTRAINT platform_model_request_records_step_id_fkey FOREIGN KEY (step_id) REFERENCES public.platform_agent_step_contexts(step_id) ON DELETE CASCADE;


--
-- Name: platform_run_domain_events platform_run_domain_events_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_domain_events
    ADD CONSTRAINT platform_run_domain_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_run_inputs platform_run_inputs_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_inputs
    ADD CONSTRAINT platform_run_inputs_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.platform_conversation_entries(entry_id) ON DELETE CASCADE;


--
-- Name: platform_run_inputs platform_run_inputs_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_inputs
    ADD CONSTRAINT platform_run_inputs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_run_inputs platform_run_inputs_model_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_inputs
    ADD CONSTRAINT platform_run_inputs_model_request_id_fkey FOREIGN KEY (model_request_id) REFERENCES public.platform_model_request_records(request_id) ON DELETE RESTRICT;


--
-- Name: platform_run_inputs platform_run_inputs_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_inputs
    ADD CONSTRAINT platform_run_inputs_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.platform_threads(thread_id) ON DELETE CASCADE;


--
-- Name: platform_run_records platform_run_records_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_records
    ADD CONSTRAINT platform_run_records_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_run_records platform_run_records_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_records
    ADD CONSTRAINT platform_run_records_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.platform_threads(thread_id) ON DELETE CASCADE;


--
-- Name: platform_run_snapshots platform_run_snapshots_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_run_snapshots
    ADD CONSTRAINT platform_run_snapshots_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_runs platform_runs_root_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_runs
    ADD CONSTRAINT platform_runs_root_run_id_fkey FOREIGN KEY (root_run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_runs platform_runs_parent_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_runs
    ADD CONSTRAINT platform_runs_parent_run_id_fkey FOREIGN KEY (parent_run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_root_run_budgets platform_root_run_budgets_root_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_root_run_budgets
    ADD CONSTRAINT platform_root_run_budgets_root_run_id_fkey FOREIGN KEY (root_run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_agent_messages platform_agent_messages_root_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_agent_messages
    ADD CONSTRAINT platform_agent_messages_root_run_id_fkey FOREIGN KEY (root_run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_agent_messages platform_agent_messages_sender_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_agent_messages
    ADD CONSTRAINT platform_agent_messages_sender_run_id_fkey FOREIGN KEY (sender_run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_agent_messages platform_agent_messages_receiver_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_agent_messages
    ADD CONSTRAINT platform_agent_messages_receiver_run_id_fkey FOREIGN KEY (receiver_run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_runs platform_runs_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_runs
    ADD CONSTRAINT platform_runs_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE SET NULL;


--
-- Name: platform_runs platform_runs_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_runs
    ADD CONSTRAINT platform_runs_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.platform_sessions(session_id) ON DELETE CASCADE;


--
-- Name: platform_runs platform_runs_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_runs
    ADD CONSTRAINT platform_runs_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.platform_threads(thread_id) ON DELETE CASCADE;


--
-- Name: platform_runs platform_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_runs
    ADD CONSTRAINT platform_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_scheduled_tasks platform_scheduled_tasks_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_scheduled_tasks
    ADD CONSTRAINT platform_scheduled_tasks_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE RESTRICT;


--
-- Name: platform_scheduled_tasks platform_scheduled_tasks_last_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_scheduled_tasks
    ADD CONSTRAINT platform_scheduled_tasks_last_run_id_fkey FOREIGN KEY (last_run_id) REFERENCES public.platform_runs(run_id) ON DELETE SET NULL;


--
-- Name: platform_scheduled_tasks platform_scheduled_tasks_target_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_scheduled_tasks
    ADD CONSTRAINT platform_scheduled_tasks_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.platform_automation_definitions(automation_id) ON DELETE RESTRICT;


--
-- Name: platform_scheduled_tasks platform_scheduled_tasks_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_scheduled_tasks
    ADD CONSTRAINT platform_scheduled_tasks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_sessions platform_sessions_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_sessions
    ADD CONSTRAINT platform_sessions_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE SET NULL;


--
-- Name: platform_sessions platform_sessions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_sessions
    ADD CONSTRAINT platform_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_thread_compactions platform_thread_compactions_boundary_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_thread_compactions
    ADD CONSTRAINT platform_thread_compactions_boundary_entry_id_fkey FOREIGN KEY (boundary_entry_id) REFERENCES public.platform_conversation_entries(entry_id) ON DELETE CASCADE;


--
-- Name: platform_thread_compactions platform_thread_compactions_first_compacted_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_thread_compactions
    ADD CONSTRAINT platform_thread_compactions_first_compacted_entry_id_fkey FOREIGN KEY (first_compacted_entry_id) REFERENCES public.platform_conversation_entries(entry_id) ON DELETE CASCADE;


--
-- Name: platform_thread_compactions platform_thread_compactions_last_compacted_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_thread_compactions
    ADD CONSTRAINT platform_thread_compactions_last_compacted_entry_id_fkey FOREIGN KEY (last_compacted_entry_id) REFERENCES public.platform_conversation_entries(entry_id) ON DELETE CASCADE;


--
-- Name: platform_thread_compactions platform_thread_compactions_preserved_from_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_thread_compactions
    ADD CONSTRAINT platform_thread_compactions_preserved_from_entry_id_fkey FOREIGN KEY (preserved_from_entry_id) REFERENCES public.platform_conversation_entries(entry_id) ON DELETE SET NULL;


--
-- Name: platform_thread_compactions platform_thread_compactions_summary_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_thread_compactions
    ADD CONSTRAINT platform_thread_compactions_summary_entry_id_fkey FOREIGN KEY (summary_entry_id) REFERENCES public.platform_conversation_entries(entry_id) ON DELETE CASCADE;


--
-- Name: platform_thread_compactions platform_thread_compactions_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_thread_compactions
    ADD CONSTRAINT platform_thread_compactions_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.platform_threads(thread_id) ON DELETE CASCADE;


--
-- Name: platform_thread_memory_versions platform_thread_memory_versions_based_on_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_thread_memory_versions
    ADD CONSTRAINT platform_thread_memory_versions_based_on_entry_id_fkey FOREIGN KEY (based_on_entry_id) REFERENCES public.platform_conversation_entries(entry_id) ON DELETE SET NULL;


--
-- Name: platform_thread_memory_versions platform_thread_memory_versions_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_thread_memory_versions
    ADD CONSTRAINT platform_thread_memory_versions_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.platform_threads(thread_id) ON DELETE CASCADE;


--
-- Name: platform_threads platform_threads_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_threads
    ADD CONSTRAINT platform_threads_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE SET NULL;


--
-- Name: platform_threads platform_threads_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_threads
    ADD CONSTRAINT platform_threads_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.platform_sessions(session_id) ON DELETE CASCADE;


--
-- Name: platform_threads platform_threads_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_threads
    ADD CONSTRAINT platform_threads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_tool_invocations platform_tool_invocations_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_tool_invocations
    ADD CONSTRAINT platform_tool_invocations_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_approval_records platform_approval_records_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_approval_records
    ADD CONSTRAINT platform_approval_records_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_approval_records platform_approval_records_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_approval_records
    ADD CONSTRAINT platform_approval_records_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.platform_threads(thread_id) ON DELETE CASCADE;


--
-- Name: platform_approval_records platform_approval_records_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_approval_records
    ADD CONSTRAINT platform_approval_records_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.platform_sessions(session_id) ON DELETE CASCADE;


--
-- Name: platform_approval_records platform_approval_records_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_approval_records
    ADD CONSTRAINT platform_approval_records_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.platform_workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: platform_approval_records platform_approval_records_invocation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_approval_records
    ADD CONSTRAINT platform_approval_records_invocation_id_fkey FOREIGN KEY (invocation_id) REFERENCES public.platform_tool_invocations(invocation_id) ON DELETE CASCADE;


--
-- Name: platform_approval_records platform_approval_records_decided_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_approval_records
    ADD CONSTRAINT platform_approval_records_decided_by_user_id_fkey FOREIGN KEY (decided_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE SET NULL;


--
-- Name: platform_approval_records platform_approval_records_source_approval_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_approval_records
    ADD CONSTRAINT platform_approval_records_source_approval_id_fkey FOREIGN KEY (source_approval_id) REFERENCES public.platform_approval_records(approval_id) ON DELETE SET NULL;


--
-- Name: platform_tool_result_commits platform_tool_result_commits_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_tool_result_commits
    ADD CONSTRAINT platform_tool_result_commits_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.platform_runs(run_id) ON DELETE CASCADE;


--
-- Name: platform_tool_result_commits platform_tool_result_commits_invocation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_tool_result_commits
    ADD CONSTRAINT platform_tool_result_commits_invocation_id_fkey FOREIGN KEY (invocation_id) REFERENCES public.platform_tool_invocations(invocation_id) ON DELETE CASCADE;


--
-- Name: platform_workspaces platform_workspaces_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_workspaces
    ADD CONSTRAINT platform_workspaces_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.platform_users(user_id) ON DELETE RESTRICT;

-- pg_dump 为避免对象解析歧义会临时清空 search_path；初始化完成后恢复
-- PostgreSQL 默认值，确保同一连接后续可以正常访问 public 业务表。
SET search_path TO "$user", public;

COMMIT;
