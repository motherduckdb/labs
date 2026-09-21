{#
  save_charts_as_dives — the whole dbt-side of publishing, in SQL.

  Runs from this package's own on-run-end hook, so a project opts in with one flag:

      vars:
        save_charts_as_dives: true

  What it does, all through the connection dbt already has open to MotherDuck:

    1. stage the dbt project (boards, dbt_charts.yml, dbt_project.yml, target/manifest.json)
       and this package's Python source into one table, with read_text();
    2. make sure a Flight named `dbt_charts_dive` exists (create or update it — its program
       is a ~20 line bootstrap that runs the staged source);
    3. trigger it with MD_RUN_FLIGHT, passing the database, the board options and the models
       that failed in this run;
    4. wait for it (sleep_ms) and report: one log line per Dive, or fail the build with the
       Flight's traceback.

  Optional knobs, none required:

      vars:
        dbt_charts_dive:
          share: true           # create (or reuse) a share of the target database and point
                                # every Dive at it, so anyone with a Dive link can open it.
                                # Refreshed at the end of the run, once the staged project
                                # source has been dropped again.
                                # Long form: {name: ..., access: organization|unrestricted,
                                # update: manual|automatic, recreate: false}
          wait: true            # false returns as soon as the Flight is queued
          timeout: 900          # seconds to wait
          fail_on_error: true   # false logs the failure instead of failing the build
          flight_name: dbt_charts_dive
          commands: [build, run, seed, snapshot, clone, retry]
                                # the dbt commands that publish; the rest (compile, test,
                                # docs, …) build no relations, so they publish nothing
          options: {}           # overrides for the dive: block of dbt_charts.yml
#}

{% macro save_charts_as_dives() %}
  {%- if not execute or not var('save_charts_as_dives', false) -%}
    {{ return("select 'dbt_charts_dive: off' as dbt_charts_dive") }}
  {%- endif -%}

  {%- set cfg = var('dbt_charts_dive', {}) -%}
  {%- set which = (invocation_args_dict | default({})).get('which') | default('', true) | string | lower -%}
  {%- if not dbt_charts_dive._publishes_on(which, cfg) -%}
    {% do log("dbt_charts_dive: nothing published on `dbt " ~ which ~ "` — it builds no relations (vars.dbt_charts_dive.commands to change)", info=true) %}
    {{ return("select 'dbt_charts_dive: not on " ~ which ~ "' as dbt_charts_dive") }}
  {%- endif -%}
  {#- Named for the program it runs, so a run never rewrites the Flight another run is
      starting: a different bootstrap is a different Flight. A project that wants to share
      one deliberately (a service account's) pins the name itself. -#}
  {%- if not (target.path is string and target.path.startswith('md:')) -%}
    {% do exceptions.raise_compiler_error(
      "save_charts_as_dives needs a MotherDuck target (profiles.yml path: 'md:<database>'); this target's path is "
      ~ (target.path | default('unset')) ~ ". Set save_charts_as_dives: false for non-MotherDuck targets.") %}
  {%- endif -%}

  {%- set flight_name = cfg.get('flight_name') | default('dbt_charts_dive' ~ dbt_charts_dive._program_fingerprint(), true) -%}
  {%- set db = target.database -%}
  {%- set schema = target.schema | default('main', true) -%}
  {#- Named for this invocation and the hour, so two runs against one database cannot
      overwrite each other's staging, and one nobody finished can be told from one in use. -#}
  {#- dbt's own run timestamp, which is UTC and the same for every hook in the run.
     Not modules.datetime: dbt exposes that as a dict of five names with no timezone. -#}
  {%- set stamp = run_started_at.strftime('%Y%m%d%H') -%}
  {%- set inputs_table = 'dbt_charts_dive_inputs_' ~ (invocation_id | string | replace('-', ''))[:12] ~ '_' ~ stamp -%}
  {%- set inputs = dbt_charts_dive._relation(db, schema, inputs_table) -%}

  {#- Board options for the Flight. When share: is on, the Dives are pointed at a share of
      this database instead of the database itself, so a Dive link works for anyone. The URL
      is resolved here — never pasted. -#}
  {%- set share = none -%}
  {%- set options = {} -%}
  {%- do options.update(cfg.get('options', {})) -%}
  {#- A Dive is a page other people open, so it reads a share of the target database and
      never the database itself: one share per run, pointed at by every Dive of that run,
      resolved once right here. What the project gets to decide is the share's reach, not
      whether there is one — a Dive attached to the raw database opens for nobody but the
      database's own grantees, which is not a dashboard. -#}
  {%- set share_spec = cfg.get('share', {}) -%}
  {%- if share_spec is sameas false -%}
    {% do exceptions.raise_compiler_error(
      "dbt_charts_dive: share: false is no longer a setting — a Dive always reads a share, or"
      ~ " nobody but the database's own grantees could open it. Say share: {access:"
      ~ " organization} for a share your MotherDuck organization can read (the default), or"
      ~ " share: {access: unrestricted} for a link that works for anyone.") %}
  {%- endif -%}
  {#- The one thing that still wins: a project that named its own resource through
      `required_databases` has already decided what the Dives attach. -#}
  {%- if not options.get('required_databases') -%}
    {%- set share = dbt_charts_dive._ensure_share(db, share_spec) -%}
    {%- do options.update({'required_databases': [db ~ '=' ~ share.url]}) -%}
  {%- endif -%}

  {% do dbt_charts_dive._drop_abandoned_inputs(db, schema, stamp) %}
  {{ dbt_charts_dive._stage_inputs(inputs) }}
  {%- set flight_id = dbt_charts_dive._ensure_flight(flight_name) -%}
  {%- set run = dbt_charts_dive._run_flight(flight_id, db, schema, options, inputs_table) -%}

  {%- if cfg.get('wait', true) -%}
    {%- set finished = dbt_charts_dive._await_flight(flight_id, run, db, schema, cfg) -%}
    {#- The staged input is spent once the Flight has read it: drop it so it does not sit in
        the database (and in any share of it). The registry and runs tables stay — they are
        this package's bookkeeping. A Flight still running keeps its input: it may be reading
        it, and its own cleanup drops it when it ends. -#}
    {%- if finished -%}
      {% do run_query("DROP TABLE IF EXISTS " ~ inputs) %}
      {#- Only now, with the staged source gone, is the share allowed to see this run: a share
          that updated itself would have carried the project's own boards and manifest to
          whoever the share reaches, for as long as the run lasted. Another run's staging
          table is the same source in the same database, so wait for that one too. -#}
      {%- if share -%}{% do dbt_charts_dive._refresh_share(share, db, schema) %}{%- endif -%}
    {%- endif -%}
  {%- else -%}
    {% do log("dbt_charts_dive: flight run " ~ run.number ~ " queued (wait: false, so fail_on_error cannot apply and nothing here reports the Dives)", info=true) %}
  {%- endif -%}

  {{ return("select 'dbt_charts_dive' as dbt_charts_dive") }}
{% endmacro %}


{#- Eight hex of this package's Flight program, or nothing when the dbt running this has no
    hash function — then the Flight keeps the plain name it always had. -#}
{% macro _program_fingerprint() %}
  {%- if local_md5 is defined -%}
    {{ return('_' ~ local_md5(dbt_charts_dive._flight_source() ~ dbt_charts_dive._flight_requirements())[:8]) }}
  {%- endif -%}
  {{ return('') }}
{% endmacro %}


{#- Which dbt commands publish. The hook runs at the end of everything that runs nodes, so
    `dbt compile` and `dbt test` reach it too — and they build no relations, so republishing
    every board there says "fresh" about yesterday's tables. A dbt that does not name the
    command in its context publishes, as it always did. -#}
{% macro _publishes_on(which, cfg) %}
  {{ return(not which or which in cfg.get('commands', ['build', 'run', 'seed', 'snapshot', 'clone', 'retry'])) }}
{% endmacro %}


{#- Every staged project sitting in this schema, this run's included: a run that was killed
    between staging and the drop leaves one behind, and nothing else would remove it. -#}
{% macro _staged_inputs(db, schema) %}
  {%- set found = run_query(
    "SELECT table_name FROM information_schema.tables WHERE table_catalog = " ~ dbt_charts_dive._lit(db) ~
    " AND table_schema = " ~ dbt_charts_dive._lit(schema) ~ " AND table_name LIKE 'dbt_charts_dive_inputs%'") -%}
  {{ return(found.rows | map(attribute=0) | map('string') | list) }}
{% endmacro %}


{#- Drop the ones from an earlier hour: a run of this package takes minutes, so an older
    staged project is nobody's any more. -#}
{% macro _drop_abandoned_inputs(db, schema, stamp) %}
  {%- for table in dbt_charts_dive._staged_inputs(db, schema) -%}
    {%- set made = table.split('_') | last -%}
    {%- if made | length == 10 and made.isdigit() and made < stamp -%}
      {% do run_query("DROP TABLE IF EXISTS " ~ dbt_charts_dive._relation(db, schema, table)) %}
      {% do log("dbt_charts_dive: dropped " ~ table ~ ", staged by a run that never finished", info=true) %}
    {%- endif -%}
  {%- endfor -%}
{% endmacro %}


{# ── 1. stage the project and this package's source into one table ───────────────────── #}
{% macro _stage_inputs(inputs) %}
  {%- set project_globs = [
        'charts/**/*.yml', 'charts/**/*.yaml', 'charts/**/*.json', 'charts/**/*.md',
        'dbt_charts.yml', 'dbt_project.yml'] -%}
  {%- set package_globs = [
        'dbt_packages/dbt_charts_dive/src/dbt_charts_dive/**/*.py',
        'dbt_packages/dbt_charts_dive/src/dbt_charts_dive/*.tsx',
        'src/dbt_charts_dive/**/*.py',
        'src/dbt_charts_dive/*.tsx'] -%}

  {#- read_text() errors on a pattern that matches nothing, so ask glob() first (it does not). -#}
  {%- set probe = [] -%}
  {%- for g in project_globs + package_globs -%}
    {%- do probe.append("SELECT " ~ dbt_charts_dive._lit(g) ~ " AS g, count(*) AS n FROM glob(" ~ dbt_charts_dive._lit(g) ~ ")") -%}
  {%- endfor -%}
  {%- set found = run_query(probe | join(' UNION ALL ')) -%}
  {%- set live = [] -%}
  {%- for row in found.rows -%}{%- if row[1] > 0 -%}{%- do live.append(row[0]) -%}{%- endif -%}{%- endfor -%}

  {%- set proj = [] -%}{%- set pkg = [] -%}
  {%- for g in live -%}
    {%- if g in package_globs -%}{%- do pkg.append(dbt_charts_dive._lit(g)) -%}
    {%- else -%}{%- do proj.append(dbt_charts_dive._lit(g)) -%}{%- endif -%}
  {%- endfor -%}

  {%- if proj | length == 0 -%}
    {% do exceptions.raise_compiler_error(
      "dbt_charts_dive: no boards found. Nothing matched " ~ project_globs | join(', ') ~
      " relative to the current directory, which is where read_text() looks — run dbt from the project root" ~
      " (--project-dir is not supported here), add a board under charts/, or set save_charts_as_dives: false.") %}
  {%- endif -%}
  {%- if pkg | length == 0 -%}
    {% do exceptions.raise_compiler_error(
      "dbt_charts_dive: cannot find this package's Python source. Expected it under "
      ~ "dbt_packages/dbt_charts_dive/src/ — run `dbt deps`, or set packages-install-path to dbt_packages.") %}
  {%- endif -%}

  {#- The Flight receives (kind, path, content): project paths stay as-is, package paths
      become importable module paths (everything after .../src/). -#}
  {%- set sql -%}
    CREATE OR REPLACE TABLE {{ inputs }} AS
    SELECT 'project' AS kind, filename AS path, content FROM read_text([{{ proj | join(', ') }}])
    UNION ALL
    SELECT 'package' AS kind, regexp_replace(filename, '^.*?src/', '') AS path, content FROM read_text([{{ pkg | join(', ') }}])
    UNION ALL
    SELECT 'project' AS kind, 'target/manifest.json' AS path, {{ dbt_charts_dive._dollar(dbt_charts_dive._manifest_json()) }} AS content
  {%- endset -%}
  {% do run_query(sql) %}
  {%- set n = run_query("SELECT count(*) FILTER (kind = 'project') AS p, count(*) FILTER (kind = 'package') AS k, sum(length(content)) AS bytes FROM " ~ inputs) -%}
  {% do log("dbt_charts_dive: staged " ~ n.rows[0][0] ~ " project files + " ~ n.rows[0][1] ~ " package files (" ~ n.rows[0][2] ~ " bytes)", info=true) %}
{% endmacro %}


{#- The slice of a dbt manifest that dbt Charts reads to resolve ref() and source():
    name, schema, alias / relation_name per refable node (see dbt_charts/core/dbt_manifest.py).
    Built from dbt's in-memory graph rather than target/manifest.json, so a board resolves
    against the models this very run built — no stale artifact, no `dbt parse` first. -#}
{% macro _manifest_json() %}
  {%- set man = {'metadata': {'generated_by': 'dbt_charts_dive'}, 'nodes': {}, 'sources': {}} -%}
  {%- for uid, n in graph.nodes.items() -%}
    {%- if (n.resource_type | string) in ['model', 'seed', 'snapshot', 'NodeType.Model', 'NodeType.Seed', 'NodeType.Snapshot'] -%}
      {%- do man['nodes'].update({uid: {
            'resource_type': (n.resource_type | string) | replace('NodeType.', '') | lower,
            'name': n.name, 'database': n.database, 'schema': n.schema,
            'alias': n.alias | default(n.name, true),
            'relation_name': n.relation_name | default('', true)}}) -%}
    {%- endif -%}
  {%- endfor -%}
  {%- for uid, sr in (graph.sources | default({}, true)).items() -%}
    {%- do man['sources'].update({uid: {
          'resource_type': 'source', 'source_name': sr.source_name, 'name': sr.name,
          'database': sr.database, 'schema': sr.schema,
          'relation_name': sr.relation_name | default('', true)}}) -%}
  {%- endfor -%}
  {{ return(tojson(man)) }}
{% endmacro %}



{# ── the share: create it or reuse it, and hand back its URL ────────────────────────────
   A share is identified by the database it was made from, so a run finds the share it made
   last time instead of minting a new one. Access/update changes need CREATE OR REPLACE,
   which mints a new URL — that is reported, since old Dive links then point at a dead share.

   It updates manually, and the run refreshes it at the very end. An automatic share would
   publish whatever the database holds at any moment — including the staging table with this
   project's boards, manifest and source — to everyone the share reaches.
#}
{#- Refresh the share, unless some other run's staged project is still sitting in the
    database: the snapshot takes the whole database, and that source is not ours to publish. -#}
{% macro _refresh_share(share, db, schema) %}
  {%- if dbt_charts_dive._staged_inputs(db, schema) | length > 0 -%}
    {% do log("dbt_charts_dive: share " ~ share.name ~ " not refreshed — another run is still staging its project here", info=true) %}
  {%- else -%}
    {% do run_query("UPDATE SHARE " ~ dbt_charts_dive._ident(share.name)) %}
    {% do log("dbt_charts_dive: refreshed share " ~ share.name, info=true) %}
  {%- endif -%}
{% endmacro %}


{% macro _ensure_share(db, spec) %}
  {%- set cfg = spec if spec is mapping else {} -%}
  {%- set name = cfg.get('name') | default(db ~ '_share', true) -%}
  {%- set access = (cfg.get('access', 'organization') | string | upper) -%}
  {%- set update = (cfg.get('update', 'manual') | string | upper) -%}
  {%- if access not in ['ORGANIZATION', 'UNRESTRICTED'] -%}
    {% do exceptions.raise_compiler_error("dbt_charts_dive: dive share access must be 'organization' or 'unrestricted', got " ~ access) %}
  {%- endif -%}
  {%- if update not in ['AUTOMATIC', 'MANUAL'] -%}
    {% do exceptions.raise_compiler_error("dbt_charts_dive: dive share update must be 'automatic' or 'manual', got " ~ update) %}
  {%- endif -%}

  {%- set found = run_query(
    "SELECT name, url, access, \"update\" FROM MD_LIST_DATABASE_SHARES() WHERE source_db_name = " ~
    dbt_charts_dive._lit(db) ~ " AND name = " ~ dbt_charts_dive._lit(name)) -%}

  {%- if found.rows | length > 0 and (found.rows[0][2] | string | upper) == access and (found.rows[0][3] | string | upper) == update -%}
    {% do log("dbt_charts_dive: dives read share " ~ name ~ " (" ~ access | lower ~ ", update " ~ update | lower ~ ")", info=true) %}
    {{ return({'name': name, 'url': found.rows[0][1]}) }}
  {%- endif -%}

  {%- set replacing = found.rows | length > 0 -%}
  {%- if replacing and not cfg.get('recreate', false) -%}
    {% do exceptions.raise_compiler_error(
      "dbt_charts_dive: share " ~ name ~ " is " ~ (found.rows[0][2] | string | lower) ~ ", update " ~ (found.rows[0][3] | string | lower) ~
      ", and this run asks for " ~ access | lower ~ ", update " ~ update | lower ~ ". Changing either re-creates the share, which mints a new URL" ~
      " and leaves every Dive published against the old one pointing at nothing. Say share: {recreate: true} to do it anyway (and this run will" ~
      " republish the Dives), or drop the share yourself.") %}
  {%- endif -%}
  {% do run_query("CREATE OR REPLACE SHARE " ~ dbt_charts_dive._ident(name) ~ " FROM " ~ dbt_charts_dive._ident(db) ~
                  " (ACCESS " ~ access ~ ", UPDATE " ~ update ~ ")") %}
  {%- set made = run_query(
    "SELECT url FROM MD_LIST_DATABASE_SHARES() WHERE source_db_name = " ~ dbt_charts_dive._lit(db) ~
    " AND name = " ~ dbt_charts_dive._lit(name)) -%}
  {%- if made.rows | length == 0 -%}
    {% do exceptions.raise_compiler_error("dbt_charts_dive: created share " ~ name ~ " but MD_LIST_DATABASE_SHARES() does not report it") %}
  {%- endif -%}
  {% do log("dbt_charts_dive: " ~ ("re-created" if replacing else "created") ~ " share " ~ name ~
            " (" ~ access | lower ~ ", update " ~ update | lower ~ ") -> " ~ made.rows[0][0] ~
            (" — its URL changed, so previously published Dive links must be rebuilt" if replacing else ""), info=true) %}
  {{ return({'name': name, 'url': made.rows[0][0]}) }}
{% endmacro %}


{# ── 2. the Flight: create it, or update it when this package's bootstrap changed ─────── #}
{% macro _ensure_flight(flight_name) %}
  {%- set src = dbt_charts_dive._flight_source() -%}
  {%- set reqs = dbt_charts_dive._flight_requirements() -%}
  {%- set existing = run_query("SELECT flight_id::VARCHAR, current_version FROM MD_LIST_FLIGHTS() WHERE flight_name = " ~ dbt_charts_dive._lit(flight_name)) -%}

  {%- if existing.rows | length == 0 -%}
    {%- set created = run_query(
      "SELECT flight_id::VARCHAR FROM MD_CREATE_FLIGHT(name := " ~ dbt_charts_dive._lit(flight_name) ~
      ", source_code := " ~ dbt_charts_dive._dollar(src) ~
      ", requirements_txt := " ~ dbt_charts_dive._dollar(reqs) ~
      ", config := " ~ dbt_charts_dive._config_map({}) ~ ")") -%}
    {%- set flight_id = created.rows[0][0] -%}
    {% do log("dbt_charts_dive: created flight '" ~ flight_name ~ "' " ~ flight_id, info=true) %}
    {{ return(flight_id) }}
  {%- endif -%}

  {%- set flight_id = existing.rows[0][0] -%}
  {%- set version = existing.rows[0][1] -%}
  {#- MD_GET_FLIGHT returns metadata only; the program lives on the version. -#}
  {%- set current = run_query(
    "SELECT source_code, requirements_txt FROM MD_GET_FLIGHT_VERSION(flight_id := " ~ dbt_charts_dive._lit(flight_id) ~
    "::UUID, version_number := " ~ version ~ ")") -%}
  {%- if current.rows[0][0] != src or current.rows[0][1] != reqs -%}
    {% do run_query(
      "SELECT flight_id FROM MD_UPDATE_FLIGHT(flight_id := " ~ dbt_charts_dive._lit(flight_id) ~ "::UUID" ~
      ", source_code := " ~ dbt_charts_dive._dollar(src) ~
      ", requirements_txt := " ~ dbt_charts_dive._dollar(reqs) ~
      ", config := " ~ dbt_charts_dive._config_map({}) ~ ")") %}
    {% do log("dbt_charts_dive: updated flight '" ~ flight_name ~ "' to this package's bootstrap", info=true) %}
  {%- endif -%}
  {{ return(flight_id) }}
{% endmacro %}


{# ── 3. trigger it with this run's context ───────────────────────────────────────────── #}
{% macro _run_flight(flight_id, db, schema, options, inputs_table) %}
  {%- set failed = [] -%}
  {%- for r in results -%}
    {%- if r.node.resource_type == 'model' and (r.status | string | lower) in ['error', 'fail', 'skipped', 'nodestatus.error', 'nodestatus.fail', 'nodestatus.skipped'] -%}
      {%- do failed.append(r.node.name) -%}
    {%- endif -%}
  {%- endfor -%}
  {%- set run = run_query(
    "SELECT run_id::VARCHAR, run_number FROM MD_RUN_FLIGHT(flight_id := " ~ dbt_charts_dive._lit(flight_id) ~ "::UUID, config := " ~
    dbt_charts_dive._config_map({'DCD_DB': db, 'DCD_SCHEMA': schema, 'DCD_INPUTS': inputs_table, 'DCD_OPTIONS': tojson(options), 'DCD_FAILED': tojson(failed)}) ~ ")") -%}
  {% do log("dbt_charts_dive: flight run " ~ run.rows[0][1] ~ " started" ~ (" (skipping boards that ref " ~ failed | join(', ') ~ ")" if failed else ""), info=true) %}
  {{ return({'id': run.rows[0][0], 'number': run.rows[0][1]}) }}
{% endmacro %}


{# ── 4. wait, then report or fail ────────────────────────────────────────────────────── #}
{#- Wait, report, and say whether the Flight actually ended (a timeout leaves it running). -#}
{% macro _await_flight(flight_id, run, db, schema, cfg) %}
  {%- set timeout = cfg.get('timeout', 900) | int -%}
  {%- set poll_ms = 3000 -%}
  {%- set state = namespace(status='PENDING', done=false) -%}
  {%- for i in range((timeout * 1000 / poll_ms) | round(0, 'ceil') | int) -%}
    {%- if not state.done -%}
      {%- set r = run_query("SELECT status FROM MD_LIST_FLIGHT_RUNS(flight_id := " ~ dbt_charts_dive._lit(flight_id) ~ "::UUID, \"limit\" := 50) WHERE run_id = " ~ dbt_charts_dive._lit(run.id) ~ "::UUID") -%}
      {%- if r.rows | length > 0 -%}
        {%- set state.status = r.rows[0][0] | string -%}
        {%- if 'SUCCEEDED' in state.status or 'FAILED' in state.status or 'CANCELLED' in state.status -%}
          {%- set state.done = true -%}
        {%- endif -%}
      {%- endif -%}
      {%- if not state.done -%}{% do run_query("SELECT sleep_ms(" ~ poll_ms ~ ")") %}{%- endif -%}
    {%- endif -%}
  {%- endfor -%}

  {%- if 'SUCCEEDED' in state.status -%}
    {%- set published = run_query(
      "SELECT r.value ->> 'key' AS k, r.value ->> 'action' AS a, r.value ->> 'url' AS u, r.value ->> 'skipped' AS s, r.value ->> 'error' AS e " ~
      "FROM " ~ dbt_charts_dive._relation(db, schema, 'dbt_charts_dive_runs') ~ ", unnest(json_extract(results, '$[*]')) AS r(value) " ~
      "WHERE run_id = " ~ dbt_charts_dive._lit(run.id)) -%}
    {%- set broken = [] -%}
    {%- for row in published.rows -%}
      {%- if row[2] -%}{% do log("dbt_charts_dive: " ~ row[1] ~ " dive " ~ row[0] ~ " -> " ~ row[2], info=true) %}
      {%- elif row[3] -%}{% do log("dbt_charts_dive: skipped " ~ row[0] ~ " (" ~ row[3] ~ ")", info=true) %}
      {%- elif row[4] -%}
        {% do log("dbt_charts_dive: FAILED " ~ row[0] ~ ": " ~ row[4], info=true) %}
        {%- do broken.append(row[0] ~ ": " ~ row[4]) -%}
      {%- endif -%}
    {%- endfor -%}
    {%- if published.rows | length == 0 -%}
      {% do log("dbt_charts_dive: the flight published nothing — no board under charts/ was eligible (see the dive: block in dbt_charts.yml)", info=true) %}
    {%- endif -%}
    {#- A board that could not be compiled is a failure too, not just a failed Flight. -#}
    {%- if broken | length > 0 -%}
      {%- set message = "dbt_charts_dive: " ~ broken | length ~ " board(s) failed to compile:\n  " ~ broken | join("\n  ") -%}
      {%- if cfg.get('fail_on_error', true) -%}
        {% do exceptions.raise_compiler_error(message) %}
      {%- else -%}
        {% do log(message, info=true) %}
      {%- endif -%}
    {%- endif -%}
  {%- else -%}
    {%- set tail = run_query("SELECT logs FROM MD_GET_FLIGHT_LOGS(flight_id := " ~ dbt_charts_dive._lit(flight_id) ~ "::UUID, run_number := " ~ run.number ~ ")") -%}
    {%- set detail = (tail.rows[0][0] | string) if tail.rows | length else '(no logs)' -%}
    {%- set outcome = ("did not finish within " ~ timeout ~ "s (status " ~ state.status ~ ")") if state.status in ['PENDING', 'RUN_STATUS_PENDING', 'RUNNING', 'RUN_STATUS_RUNNING'] else state.status -%}
    {%- set message = "dbt_charts_dive: flight run " ~ run.number ~ " " ~ outcome ~ ". Flight log tail:\n" ~ detail[-2000:] -%}
    {%- if cfg.get('fail_on_error', true) -%}
      {% do exceptions.raise_compiler_error(message) %}
    {%- else -%}
      {% do log(message, info=true) %}
    {%- endif -%}
  {%- endif -%}
  {{ return(state.done) }}
{% endmacro %}


{# ── helpers ─────────────────────────────────────────────────────────────────────────── #}

{#- A single-quoted SQL string literal. -#}
{% macro _lit(value) -%}
  '{{ (value | string) | replace("'", "''") }}'
{%- endmacro %}

{#- A quoted ``"db"."schema"."name"``. -#}
{% macro _relation(db, schema, name) -%}
  {{ dbt_charts_dive._ident(db) }}.{{ dbt_charts_dive._ident(schema) }}.{{ dbt_charts_dive._ident(name) }}
{%- endmacro %}

{#- A double-quoted SQL identifier. -#}
{% macro _ident(name) -%}
  "{{ (name | string) | replace('"', '""') }}"
{%- endmacro %}

{#- A dollar-quoted SQL literal, for Python source and other text with quotes in it. -#}
{% macro _dollar(value) -%}
  {%- if '$dcd$' in (value | string) -%}
    {% do exceptions.raise_compiler_error("dbt_charts_dive: cannot quote text containing $dcd$ for SQL") %}
  {%- endif -%}
  $dcd${{ value }}$dcd$
{%- endmacro %}

{#- The Flight's config map. Keys must exist on the Flight before a run can override them,
    so every key this package ever passes is declared here with a harmless default. -#}
{% macro _config_map(overrides) -%}
  {%- set defaults = {'DCD_DB': target.database, 'DCD_SCHEMA': target.schema | default('main', true),
                      'DCD_INPUTS': 'dbt_charts_dive_inputs', 'DCD_STAGE': '/tmp/dbt_charts_dive',
                      'DCD_OPTIONS': '{}', 'DCD_FAILED': '[]'} -%}
  {%- set merged = {} -%}
  {%- for k, v in defaults.items() -%}{%- do merged.update({k: overrides.get(k, v)}) -%}{%- endfor -%}
  MAP{
  {%- for k, v in merged.items() -%}
    {{ dbt_charts_dive._lit(k) }}: {{ dbt_charts_dive._lit(v) }}{{ ", " if not loop.last }}
  {%- endfor -%}
  }
{%- endmacro %}
