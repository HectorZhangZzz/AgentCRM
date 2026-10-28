import pg from "pg";
import { validateLocalUrl } from "./config.mjs";

// Twenty is a rebuildable CRM view. Evidence, six-state tasks and audit live in
// the domain schema. Never infer a customer identity from its name here.
export function createProjection(config, domain) {
  let timer,
    running = false,
    stopped = false,
    pool;
  let state = {
    enabled: !!config.twenty?.url,
    lastSyncAt: null,
    status: "pending",
    synced: 0,
    errors: [],
  };
  async function gql(query, variables = {}) {
    validateLocalUrl(config.twenty.url);
    const token = config.twenty.apiKey || config.twenty.token;
    if (!token)
      throw new Error("Twenty projection credential is not configured");
    const response = await fetch(new URL("/graphql", config.twenty.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.json();
    if (!response.ok || body.errors?.length)
      throw new Error(
        body.errors?.[0]?.message || `Twenty HTTP ${response.status}`,
      );
    return body.data;
  }
  async function sync() {
    if (running) return { ...state, status: "running" };
    if (!state.enabled) return { ...state, status: "disabled" };
    running = true;
    state = { ...state, status: "running", errors: [], synced: 0 };
    try {
      pool ||= new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
      await pool.query("CREATE SCHEMA IF NOT EXISTS portable_projection");
      await pool.query(
        `CREATE TABLE IF NOT EXISTS portable_projection.entity_map(domain_id uuid PRIMARY KEY,object_name text NOT NULL,twenty_id uuid NOT NULL,last_payload jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`,
      );
      const data = await domain.exportData();
      const entities = data.tables.entities || [];
      const relations = data.tables.relations || [];
      const byId = new Map(entities.map((e) => [e.id, e]));
      const mappings = new Map(
        (
          await pool.query("SELECT * FROM portable_projection.entity_map")
        ).rows.map((m) => [m.domain_id, m]),
      );
      const wanted = entities
        .filter((e) =>
          ["customer", "organization", "contact", "project"].includes(e.type),
        )
        .sort(
          (a, b) =>
            ["customer", "organization", "contact", "project"].indexOf(a.type) -
            ["customer", "organization", "contact", "project"].indexOf(b.type),
        );
      for (const entity of wanted) {
        try {
          const kind =
            entity.type === "contact"
              ? "person"
              : entity.type === "project"
                ? "opportunity"
                : "company";
          const plural = {
            company: "companies",
            person: "people",
            opportunity: "opportunities",
          }[kind];
          const capital = kind[0].toUpperCase() + kind.slice(1);
          const payload =
            kind === "person"
              ? { name: { firstName: entity.name, lastName: "" } }
              : { name: entity.name };
          if (kind !== "company") {
            const candidates = relations
              .filter((r) => r.from_id === entity.id || r.to_id === entity.id)
              .map((r) =>
                byId.get(r.from_id === entity.id ? r.to_id : r.from_id),
              )
              .filter((e) => e?.type === "customer");
            const ids = [...new Set(candidates.map((c) => c.id))];
            if (ids.length > 1)
              throw new Error("多个客户归属，投影暂缓，需在领域记录中澄清");
            if (ids.length === 1) {
              if (!mappings.has(ids[0])) throw new Error("客户投影尚未就绪");
              payload.companyId = mappings.get(ids[0]).twenty_id;
            }
          }
          const mapping = mappings.get(entity.id);
          const selection =
            kind === "person"
              ? "id name{firstName lastName} companyId"
              : kind === "opportunity"
                ? "id name companyId"
                : "id name";
          const found = await gql(
            `query($filter:${capital}FilterInput!){${plural}(filter:$filter){edges{node{${selection}}}}}`,
            { filter: { id: { eq: entity.id } } },
          );
          const current = found[plural].edges[0]?.node;
          if (current && mapping) {
            const drift = Object.keys(mapping.last_payload).some(
              (key) =>
                JSON.stringify(current[key] ?? null) !==
                JSON.stringify(mapping.last_payload[key] ?? null),
            );
            if (drift)
              throw new Error(
                "Twenty 记录被手工修改，已保留外部改动并暂停该记录同步",
              );
          } else if (current && !mapping) {
            throw new Error("Twenty 已有相同稳定 ID 但无投影映射，拒绝覆盖");
          }
          if (!current) {
            const created = await gql(
              `mutation($data:${capital}CreateInput!){create${capital}(data:$data){id}}`,
              { data: { id: entity.id, ...payload } },
            );
            if (created["create" + capital].id !== entity.id)
              throw new Error("Twenty 未保留指定稳定 ID");
          } else if (
            JSON.stringify(payload) !== JSON.stringify(mapping.last_payload)
          ) {
            await gql(
              `mutation($id:UUID!,$data:${capital}UpdateInput!){update${capital}(id:$id,data:$data){id}}`,
              { id: entity.id, data: payload },
            );
          }
          await pool.query(
            "INSERT INTO portable_projection.entity_map(domain_id,object_name,twenty_id,last_payload) VALUES($1,$2,$1,$3) ON CONFLICT(domain_id) DO UPDATE SET last_payload=$3,updated_at=now()",
            [entity.id, kind, JSON.stringify(payload)],
          );
          mappings.set(entity.id, {
            twenty_id: entity.id,
            last_payload: payload,
          });
          state.synced++;
        } catch (error) {
          state.errors.push({ entityId: entity.id, message: error.message });
        }
      }
      state.status = state.errors.length ? "partial" : "ok";
      state.lastSyncAt = new Date().toISOString();
    } catch (error) {
      state.status = "error";
      state.errors.push({ message: error.message });
    } finally {
      running = false;
    }
    return { ...state };
  }
  function schedule() {
    if (stopped || !state.enabled) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      sync().finally(() => {
        if (!stopped) {
          timer = setTimeout(schedule, 60000);
          timer.unref();
        }
      });
    }, 1000);
    timer.unref();
  }
  return {
    sync,
    schedule,
    status: () => ({ ...state }),
    stop() {
      stopped = true;
      clearTimeout(timer);
      pool?.end().catch(() => {});
    },
  };
}
