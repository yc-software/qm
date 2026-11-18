SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = 0;
SET LOCAL idle_in_transaction_session_timeout = 0;
SET LOCAL client_encoding = 'UTF8';
SET LOCAL standard_conforming_strings = on;
SET LOCAL check_function_bodies = false;
SET LOCAL xmloption = content;
SET LOCAL client_min_messages = warning;
SET LOCAL row_security = off;
SET LOCAL default_tablespace = '';
SET LOCAL default_table_access_method = heap;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE FUNCTION public.claim_memory_tenants() RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ SELECT tenant_id, 'memory'::text FROM memory_facts WHERE deleted_at IS NULL AND tenant_id IN (SELECT qm_serving_tenants())
           UNION SELECT tenant_id, 'memory'::text FROM memory_fact_vectors WHERE true AND tenant_id IN (SELECT qm_serving_tenants()) $$;

CREATE FUNCTION public.memory_fact_vectors_bits() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
          NEW.embedding_bits := binary_quantize(NEW.embedding);
          RETURN NEW;
        END $$;

CREATE TABLE public.memory_fact_vectors (
    scope_id text NOT NULL,
    model text NOT NULL,
    fact_id bigint NOT NULL,
    fact_hash text NOT NULL,
    dimensions integer NOT NULL,
    embedding public.vector NOT NULL,
    embedding_bits bit varying,
    tenant_id uuid DEFAULT public.qm_bound_tenant() NOT NULL,
    CONSTRAINT memory_fact_vectors_check CHECK ((public.vector_dims(embedding) = dimensions)),
    CONSTRAINT memory_fact_vectors_dimensions_check CHECK (((dimensions >= 1) AND (dimensions <= 16000)))
);

ALTER TABLE ONLY public.memory_fact_vectors
    ADD CONSTRAINT memory_fact_vectors_pkey PRIMARY KEY (tenant_id, scope_id, model, fact_id);

CREATE TRIGGER memory_fact_vectors_bits BEFORE INSERT OR UPDATE OF embedding ON public.memory_fact_vectors FOR EACH ROW EXECUTE FUNCTION public.memory_fact_vectors_bits();

ALTER TABLE ONLY public.memory_fact_vectors
    ADD CONSTRAINT memory_fact_vectors_tenant FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE public.memory_fact_vectors ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.memory_fact_vectors USING ((tenant_id = public.qm_bound_tenant())) WITH CHECK ((tenant_id = public.qm_bound_tenant()));
