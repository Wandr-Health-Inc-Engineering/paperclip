CREATE TABLE "tethr_agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"division_id" uuid,
	"tag" text NOT NULL,
	"codename" text NOT NULL,
	"mission" text,
	"approval_gate" text DEFAULT 'none' NOT NULL,
	"heartbeat_cron" text,
	"heartbeat_note" text,
	"port_priority" integer,
	"routing_table" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"standing_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"spec_drive_node_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tethr_divisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"head_agent_id" uuid,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tethr_drive_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" text DEFAULT 'file' NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"content_type" text,
	"current_version_id" uuid,
	"permissions" jsonb DEFAULT '{"owner":"mark","read":["*"],"write":["mark"]}'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"byte_size" integer,
	"created_by_tag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tethr_drive_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"object_key" text NOT NULL,
	"byte_size" integer DEFAULT 0 NOT NULL,
	"sha256" text,
	"content_type" text,
	"note" text,
	"created_by_tag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tethr_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"kind" text DEFAULT 'fact' NOT NULL,
	"content" text NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tethr_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text DEFAULT 'system' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"agent_tag" text,
	"channel" text DEFAULT 'in_app' NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tethr_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"subagent_id" uuid,
	"route_run_id" uuid,
	"heartbeat_run_id" uuid,
	"kind" text DEFAULT 'document' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"sensitivity" text DEFAULT 'internal' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approval_id" uuid,
	"drive_node_id" uuid,
	"published_at" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tethr_route_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_text" text NOT NULL,
	"requested_by_user_id" text,
	"invocation_source" text DEFAULT 'console' NOT NULL,
	"status" text DEFAULT 'routing' NOT NULL,
	"hops" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_id" uuid,
	"subagent_id" uuid,
	"heartbeat_run_id" uuid,
	"result_text" text,
	"error" text,
	"llm_provider" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tethr_subagents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"tag" text NOT NULL,
	"name" text NOT NULL,
	"job" text NOT NULL,
	"route_when" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"not_here" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output" text,
	"guardrails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"done_when" text,
	"escalation" text,
	"sensitivity" text DEFAULT 'internal' NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"last_run_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tethr_agent_profiles" ADD CONSTRAINT "tethr_agent_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_agent_profiles" ADD CONSTRAINT "tethr_agent_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_agent_profiles" ADD CONSTRAINT "tethr_agent_profiles_division_id_tethr_divisions_id_fk" FOREIGN KEY ("division_id") REFERENCES "public"."tethr_divisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_divisions" ADD CONSTRAINT "tethr_divisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_divisions" ADD CONSTRAINT "tethr_divisions_head_agent_id_agents_id_fk" FOREIGN KEY ("head_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_drive_nodes" ADD CONSTRAINT "tethr_drive_nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_drive_nodes" ADD CONSTRAINT "tethr_drive_nodes_parent_id_tethr_drive_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tethr_drive_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_drive_versions" ADD CONSTRAINT "tethr_drive_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_drive_versions" ADD CONSTRAINT "tethr_drive_versions_node_id_tethr_drive_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."tethr_drive_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_memories" ADD CONSTRAINT "tethr_memories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_memories" ADD CONSTRAINT "tethr_memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_notifications" ADD CONSTRAINT "tethr_notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_outputs" ADD CONSTRAINT "tethr_outputs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_outputs" ADD CONSTRAINT "tethr_outputs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_outputs" ADD CONSTRAINT "tethr_outputs_subagent_id_tethr_subagents_id_fk" FOREIGN KEY ("subagent_id") REFERENCES "public"."tethr_subagents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_outputs" ADD CONSTRAINT "tethr_outputs_route_run_id_tethr_route_runs_id_fk" FOREIGN KEY ("route_run_id") REFERENCES "public"."tethr_route_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_outputs" ADD CONSTRAINT "tethr_outputs_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_outputs" ADD CONSTRAINT "tethr_outputs_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_outputs" ADD CONSTRAINT "tethr_outputs_drive_node_id_tethr_drive_nodes_id_fk" FOREIGN KEY ("drive_node_id") REFERENCES "public"."tethr_drive_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_route_runs" ADD CONSTRAINT "tethr_route_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_route_runs" ADD CONSTRAINT "tethr_route_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_route_runs" ADD CONSTRAINT "tethr_route_runs_subagent_id_tethr_subagents_id_fk" FOREIGN KEY ("subagent_id") REFERENCES "public"."tethr_subagents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_route_runs" ADD CONSTRAINT "tethr_route_runs_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_subagents" ADD CONSTRAINT "tethr_subagents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_subagents" ADD CONSTRAINT "tethr_subagents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tethr_agent_profiles_agent_idx" ON "tethr_agent_profiles" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tethr_agent_profiles_company_tag_idx" ON "tethr_agent_profiles" USING btree ("company_id","tag");--> statement-breakpoint
CREATE INDEX "tethr_agent_profiles_company_division_idx" ON "tethr_agent_profiles" USING btree ("company_id","division_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tethr_divisions_company_key_idx" ON "tethr_divisions" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "tethr_divisions_company_status_idx" ON "tethr_divisions" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tethr_drive_nodes_company_path_idx" ON "tethr_drive_nodes" USING btree ("company_id","path");--> statement-breakpoint
CREATE INDEX "tethr_drive_nodes_company_parent_idx" ON "tethr_drive_nodes" USING btree ("company_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tethr_drive_versions_node_version_idx" ON "tethr_drive_versions" USING btree ("node_id","version_number");--> statement-breakpoint
CREATE INDEX "tethr_drive_versions_company_node_idx" ON "tethr_drive_versions" USING btree ("company_id","node_id");--> statement-breakpoint
CREATE INDEX "tethr_memories_company_agent_idx" ON "tethr_memories" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "tethr_memories_company_created_idx" ON "tethr_memories" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "tethr_notifications_company_read_idx" ON "tethr_notifications" USING btree ("company_id","read_at");--> statement-breakpoint
CREATE INDEX "tethr_notifications_company_created_idx" ON "tethr_notifications" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "tethr_outputs_company_status_idx" ON "tethr_outputs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "tethr_outputs_company_created_idx" ON "tethr_outputs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "tethr_outputs_approval_idx" ON "tethr_outputs" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "tethr_route_runs_company_created_idx" ON "tethr_route_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "tethr_route_runs_company_status_idx" ON "tethr_route_runs" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tethr_subagents_agent_key_idx" ON "tethr_subagents" USING btree ("agent_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "tethr_subagents_company_tag_idx" ON "tethr_subagents" USING btree ("company_id","tag");--> statement-breakpoint
CREATE INDEX "tethr_subagents_company_agent_idx" ON "tethr_subagents" USING btree ("company_id","agent_id");