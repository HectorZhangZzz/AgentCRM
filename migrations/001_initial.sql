CREATE TABLE portable_crm.materials (
 id uuid PRIMARY KEY, sha256 text NOT NULL UNIQUE, filename text NOT NULL, mime_type text NOT NULL,
 byte_length bigint NOT NULL, object_path text NOT NULL, text_content text, extraction_status text NOT NULL,
 source text, occurred_at timestamptz, quality_flags jsonb NOT NULL DEFAULT '[]', version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE portable_crm.material_receipts (id uuid PRIMARY KEY,material_id uuid NOT NULL REFERENCES portable_crm.materials(id),source text,occurred_at timestamptz,filename text,actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE portable_crm.entities (id uuid PRIMARY KEY,type text NOT NULL CHECK (type IN ('customer','contact','project','organization','issue')),name text NOT NULL,aliases jsonb NOT NULL DEFAULT '[]',version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE portable_crm.material_entities(material_id uuid NOT NULL REFERENCES portable_crm.materials(id),entity_id uuid NOT NULL REFERENCES portable_crm.entities(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(material_id,entity_id));
CREATE TABLE portable_crm.evidence(id uuid PRIMARY KEY,material_id uuid NOT NULL REFERENCES portable_crm.materials(id),quote text NOT NULL,locator jsonb NOT NULL,note text,verification text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE portable_crm.object_evidence(object_type text NOT NULL,object_id uuid NOT NULL,evidence_id uuid NOT NULL REFERENCES portable_crm.evidence(id),PRIMARY KEY(object_type,object_id,evidence_id));
CREATE TABLE portable_crm.facts(id uuid PRIMARY KEY,entity_id uuid NOT NULL REFERENCES portable_crm.entities(id),key text NOT NULL,value jsonb NOT NULL,classification text NOT NULL CHECK(classification IN ('user_provided','customer_claim','verified','inference','suggestion')),version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(entity_id,key));
CREATE TABLE portable_crm.fact_versions(id uuid PRIMARY KEY,fact_id uuid NOT NULL REFERENCES portable_crm.facts(id),entity_id uuid NOT NULL REFERENCES portable_crm.entities(id),version integer NOT NULL,value jsonb NOT NULL,classification text NOT NULL,evidence_ids jsonb NOT NULL,reason text NOT NULL,actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(fact_id,version));
CREATE TABLE portable_crm.relations(id uuid PRIMARY KEY,from_id uuid NOT NULL REFERENCES portable_crm.entities(id),to_id uuid NOT NULL REFERENCES portable_crm.entities(id),kind text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(from_id,to_id,kind));
CREATE TABLE portable_crm.tasks(id uuid PRIMARY KEY,task_key text NOT NULL UNIQUE,entity_id uuid NOT NULL REFERENCES portable_crm.entities(id),project_id uuid REFERENCES portable_crm.entities(id),title text NOT NULL,party text NOT NULL CHECK(party IN ('self','colleague','customer','waiting')),owner text,due_at timestamptz,waiting_for text,status text NOT NULL CHECK(status IN ('todo','in_progress','awaiting_feedback','on_hold','completed','cancelled')),version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE portable_crm.task_versions(id uuid PRIMARY KEY,task_id uuid NOT NULL REFERENCES portable_crm.tasks(id),version integer NOT NULL,snapshot jsonb NOT NULL,evidence_ids jsonb NOT NULL,actor text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(task_id,version));
CREATE TABLE portable_crm.proposals(id uuid PRIMARY KEY,idempotency_key text NOT NULL UNIQUE,payload_hash text NOT NULL,material_ids jsonb NOT NULL,operations jsonb NOT NULL,status text NOT NULL DEFAULT 'proposed',conflicts jsonb NOT NULL DEFAULT '[]',result jsonb,actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE portable_crm.idempotency(action text NOT NULL,key text NOT NULL,payload_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(action,key));
CREATE TABLE portable_crm.audit(id uuid PRIMARY KEY,action text NOT NULL,actor text NOT NULL,object_type text,object_id uuid,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX materials_text_idx ON portable_crm.materials USING gin(to_tsvector('simple',coalesce(text_content,'')));
CREATE INDEX evidence_material_idx ON portable_crm.evidence(material_id);
CREATE INDEX facts_entity_idx ON portable_crm.facts(entity_id);
CREATE INDEX tasks_entity_status_idx ON portable_crm.tasks(entity_id,status);
CREATE INDEX audit_object_idx ON portable_crm.audit(object_type,object_id,created_at);
CREATE INDEX relations_to_idx ON portable_crm.relations(to_id);
