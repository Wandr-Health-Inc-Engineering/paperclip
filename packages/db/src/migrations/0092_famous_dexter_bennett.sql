CREATE TABLE "tethr_org_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"output_id" uuid,
	"op" text NOT NULL,
	"target_agent_id" uuid,
	"target_tag" text NOT NULL,
	"before" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"after" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'applied' NOT NULL,
	"revert_of_change_id" uuid,
	"reverted_by_change_id" uuid,
	"applied_by" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tethr_org_changes" ADD CONSTRAINT "tethr_org_changes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tethr_org_changes" ADD CONSTRAINT "tethr_org_changes_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tethr_org_changes_company_applied_idx" ON "tethr_org_changes" USING btree ("company_id","applied_at");--> statement-breakpoint
CREATE INDEX "tethr_org_changes_company_target_idx" ON "tethr_org_changes" USING btree ("company_id","target_agent_id");